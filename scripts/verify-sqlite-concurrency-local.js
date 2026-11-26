'use strict';

// One serial control and one bounded four-client trial. Each trial owns two
// loopback server processes and a single disposable local SQLite database.
const assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,mkdir,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {performance}=require('node:perf_hooks');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const workspaces=['alpha','beta'];
const rights='/api/rights/cases';
const rounds=8, conflictRounds=3;
const round=value=>Number(value.toFixed(3));
const sessionId=(workspace,role)=>'fixture-'+workspace+'-'+role;
function measure(samples,elapsed){
  const sorted=samples.slice().sort((a,b)=>a-b);
  const percentile=p=>round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]);
  return {requests:sorted.length,elapsedMs:round(elapsed),requestsPerSecond:round(sorted.length*1000/elapsed),
    p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:percentile(1)};
}

function worker(){
  if(!process.send){process.exitCode=1;return;}
  let server;
  const finish=()=>{
    if(!server?.listening){if(process.connected)process.disconnect();return;}
    server.closeAllConnections();
    server.close(()=>{if(process.connected)process.disconnect();});
  };
  process.on('disconnect',finish);
  process.on('message',packet=>{
    if(packet.type==='stop'){finish();return;}
    if(packet.type!=='start'||server)return;
    try{
      server=createServer(packet.options);
      server.once('error',()=>{process.send?.({type:'start-failed'});finish();});
      server.listen(0,'127.0.0.1',()=>process.send?.({type:'listening',port:server.address().port}));
    }catch{process.send?.({type:'start-failed'});finish();}
  });
}

async function trial(root,concurrency){
  const folder=join(root,'trial-'+concurrency);
  await mkdir(folder,{mode:0o700});
  const deadline=AbortSignal.timeout(22_000);
  const started=performance.now();
  const peers=new Set();
  const codes=new Map(), accounts=[];
  for(const workspace of workspaces)for(const role of ['analyst','reviewer']){
    const id=sessionId(workspace,role),secret=randomBytes(32).toString('base64url');
    codes.set(id,secret);accounts.push({id,codeHash:codeHash(secret),memberships:{[workspace]:role}});
  }
  const options={dataFile:join(folder,'not-used.json'),sqliteFile:join(folder,'fixture.sqlite'),isolated:{
    root:join(folder,'workspaces'),workspaces:workspaces.map(id=>({id,label:'Fictional '+id})),accounts,
    // Provision both scopes before the measured writes; startup isn't a race.
    attachmentReviewWorkspaces:workspaces
  }};
  let phase='launch';
  const statuses={}, observations=[];
  async function launch(){
    const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TRUST_SQLITE_DRIVER','TRUST_RUST_CORE'].flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]]]));
    const child=fork(__filename,['--worker'],{env,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
    peers.add(child);
    child.once('exit',()=>peers.delete(child));
    const listening=await new Promise((resolve,reject)=>{
      const guard=setTimeout(()=>reject(Error('Timed out waiting for an isolated worker.')),5000);
      const exited=()=>{clearTimeout(guard);reject(Error('Isolated worker exited before readiness.'));};
      child.once('exit',exited);
      child.once('error',exited);
      child.once('message',data=>{
        clearTimeout(guard);
        child.removeListener('exit',exited);child.removeListener('error',exited);
        if(data.type==='listening'&&Number.isSafeInteger(data.port)&&data.port>0)resolve(data.port);
        else reject(Error('Isolated worker did not produce a ready listener.'));
      });
      child.send({type:'start',options});
    });
    const peer={child,origin:'http://127.0.0.1:'+listening};
    const health=await request(peer,'readiness','/health/ready',{scope:null});
    assert.equal(health.value.status,'ready');
    return peer;
  }
  async function stop(child){
    if(child.exitCode!==null||child.signalCode!==null)return;
    const done=once(child,'exit');
    const guard=setTimeout(()=>child.kill('SIGTERM'),2000);
    if(child.connected)child.send({type:'stop'});
    else child.kill('SIGTERM');
    try{await done;}
    finally{clearTimeout(guard);}
  }
  async function request(peer,label,path,{scope,cookie,body,allowed=[200],code}={}){
    deadline.throwIfAborted();
    const url=new URL(path,peer.origin);
    assert.equal(url.origin,peer.origin);
    if(scope)url.searchParams.set('workspace',scope);
    const timing=performance.now();
    const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{
      ...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:peer.origin,'Content-Type':'application/json'})
    },...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',
    signal:AbortSignal.any([deadline,AbortSignal.timeout(5000)])});
    const value=await response.json(), ms=performance.now()-timing;
    const {status}=response;
    statuses[status]=(statuses[status]??0)+1;
    observations.push({phase,label,status,ms:round(ms)});
    assert.ok(allowed.includes(status),phase+' / '+label+' returned '+status+
      (value.code?' '+value.code:'')+', expected '+allowed.join(' or '));
    if(code)assert.equal(value.code,code,phase+' / '+label+' denial code');
    return {value,response,status,ms};
  }
  async function signIn(peer,workspace,role){
    const id=sessionId(workspace,role);
    const result=await request(peer,'sign in '+workspace+' '+role,'/api/session/login',{scope:null,body:{
      account:id,workspace,code:codes.get(id)
    }});
    assert.equal(result.value.workspace,workspace);
    assert.equal(result.value.actor,role);
    const cookie=result.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return {peer,cookie,scope:workspace};
  }
  async function create(client,summary,kind){
    const result=await request(client.peer,'create '+summary,rights,{scope:client.scope,cookie:client.cookie,body:{
      kind,owner:'analyst',days:7,note:summary
    }});
    const hits=result.value.cases.filter(record=>record.summary===summary);
    assert.equal(hits.length,1);
    assert.equal(hits[0].revision,1);
    assert.ok(result.value.cases.every(record=>record.summary.startsWith('Fictional '+client.scope+' ')));
    return {id:hits[0].id,scope:client.scope,summary,ms:result.ms};
  }
  const view=(client,label)=>request(client.peer,label,rights,{scope:client.scope,cookie:client.cookie});
  const audit=(client,label)=>request(client.peer,label,'/api/audit/export',{scope:client.scope,cookie:client.cookie});
  const batch=async(tasks,run)=>{
    if(concurrency===4)return Promise.all(tasks.map(run));
    const values=[];
    for(const task of tasks)values.push(await run(task));
    return values;
  };
  const matches=(cases,id)=>cases.find(record=>record.id===id);
  const inspect=(scope,cases,events,ack,conflicts)=>{
    const kept=ack.filter(row=>row.scope===scope);
    assert.equal(cases.length,rounds*2+conflictRounds);
    assert.equal(new Set(cases.map(row=>row.id)).size,cases.length);
    assert.equal(new Set(cases.map(row=>row.summary)).size,cases.length);
    assert.deepEqual(new Set(cases.map(row=>row.id)),new Set(kept.map(row=>row.id)));
    assert.ok(cases.every(row=>row.summary.startsWith('Fictional '+scope+' ')));
    assert.equal(events.length,rounds*2+3*conflictRounds);
    assert.equal(new Set(events.map(event=>event.id)).size,events.length);
    assert.deepEqual(events.map(event=>event.sequence),events.map((_,i)=>i+1));
    assert.ok(events.every(event=>kept.some(row=>row.id===event.entityId)));
    const writes=events.filter(e=>e.action==='rights.case.opened');
    assert.deepEqual(new Set(writes.map(e=>e.entityId)),new Set(kept.map(row=>row.id)));
    assert.equal(writes.length,kept.length);
    const refusals=events.filter(e=>e.action==='rights.case.refused');
    assert.equal(refusals.length,conflictRounds);
    assert.ok(refusals.every(e=>e.details.code==='STALE_REVISION'));
    for(const winning of conflicts.filter(row=>row.scope===scope)){
      const state=matches(cases,winning.id);
      assert.equal(state.revision,2);
      assert.equal(state.identity.status,winning.operation==='verify'?'verified':'not-verified');
      assert.equal(events.filter(e=>e.entityId===winning.id&&e.action==='rights.case.'+winning.operation).length,1);
      assert.equal(refusals.filter(e=>e.entityId===winning.id).length,1);
    }
  };
  try{
    const servers=[await launch(),await launch()];
    assert.notEqual(servers[0].child.pid,servers[1].child.pid);
    const author={},reviewer={};
    phase='authentication';
    for(const scope of workspaces){
      author[scope]=[];reviewer[scope]=[];
      for(const peer of servers){
        author[scope].push(await signIn(peer,scope,'analyst'));
        reviewer[scope].push(await signIn(peer,scope,'reviewer'));
      }
    }
    phase='legitimate writes across workspaces';
    const ack=[],bulkTimes=[];
    const bulkStart=performance.now();
    for(let i=0;i<rounds;i++){
      const shape=[
        [author.alpha[0],'alpha','left','access'],[author.beta[0],'beta','left','deletion'],
        [author.alpha[1],'alpha','right','correction'],[author.beta[1],'beta','right','portability']
      ];
      const values=await batch(shape,([client,scope,lane,kind])=>create(client,'Fictional '+scope+' '+lane+' '+i,kind));
      ack.push(...values);bulkTimes.push(...values.map(row=>row.ms));
    }
    const bulk=measure(bulkTimes,performance.now()-bulkStart);
    phase='prepare exact conflicts';
    const targets={alpha:[],beta:[]};
    for(const scope of workspaces)for(let i=0;i<conflictRounds;i++){
      const prepared=await create(author[scope][i%2],'Fictional '+scope+' conflict '+i,'access');
      ack.push(prepared);targets[scope].push(prepared);
    }
    phase='same-record stale conflicts';
    const conflicts=[],conflictTimes=[];
    const conflictStart=performance.now();
    for(let i=0;i<conflictRounds;i++){
      const requests=workspaces.flatMap(scope=>reviewer[scope].map((client,index)=>({
        client,row:targets[scope][i],operation:index===0?'verify':'deny-verification'
      })));
      const results=await batch(requests,async({client,row,operation})=>{
        const result=await request(client.peer,row.scope+' conflict '+i+' '+operation,rights+'/'+row.id+'/'+operation,{
          scope:row.scope,cookie:client.cookie,allowed:[200,409],body:{expectedRevision:1,note:'Fictional independent identity decision.'}
        });
        if(result.status===409)assert.equal(result.value.code,'STALE_REVISION');
        else assert.equal(matches(result.value.cases,row.id).revision,2);
        return {scope:row.scope,id:row.id,operation,status:result.status,ms:result.ms};
      });
      for(const scope of workspaces){
        const pair=results.filter(row=>row.scope===scope);
        assert.deepEqual(pair.map(row=>row.status).sort(),[200,409]);
        conflicts.push(pair.find(row=>row.status===200));
      }
      conflictTimes.push(...results.map(row=>row.ms));
    }
    const competing=measure(conflictTimes,performance.now()-conflictStart);
    assert.equal(new Set(ack.map(row=>row.id)).size,ack.length);
    phase='scope fences and baseline state';
    const wrongScope=await request(servers[0],'deny tenant mismatch',rights,{scope:'beta',cookie:reviewer.alpha[0].cookie,allowed:[403]});
    assert.doesNotMatch(JSON.stringify(wrongScope.value),/Fictional (?:alpha|beta)/);
    const absent=await request(servers[1],'deny another tenant record identifier',rights+'/'+targets.alpha[0].id+'/verify',{
      scope:'beta',cookie:reviewer.beta[1].cookie,allowed:[404],code:'NOT_FOUND',body:{expectedRevision:1,note:'Fictional direct check.'}
    });
    assert.doesNotMatch(JSON.stringify(absent.value),/Fictional alpha/);
    const before={};
    for(const scope of workspaces){
      const cases=(await view(reviewer[scope][0],'read exact '+scope+' case set before restart')).value.cases;
      const events=(await audit(reviewer[scope][1],'read committed '+scope+' audit before restart')).value.audit;
      inspect(scope,cases,events,ack,conflicts);before[scope]={cases,events};
    }
    phase='close both processes and restart against same database';
    await stop(servers[0].child);await stop(servers[1].child);
    const restored=await launch();
    for(const scope of workspaces){
      await request(restored,'reject stale '+scope+' session after subprocess restart',rights,{
        scope,cookie:reviewer[scope][0].cookie,allowed:[401]
      });
      const reader=await signIn(restored,scope,'reviewer');
      const cases=(await view(reader,'read exact '+scope+' cases after restart')).value.cases;
      const events=(await audit(reader,'read committed '+scope+' audit after restart')).value.audit;
      inspect(scope,cases,events,ack,conflicts);
      assert.deepEqual(cases,before[scope].cases);assert.deepEqual(events,before[scope].events);
    }
    await stop(restored.child);
    return {concurrency,serverProcessesBeforeRestart:2,acknowledgedUniqueRows:ack.length,workspaces:2,
      rowsPerWorkspace:rounds*2+conflictRounds,auditEventsPerWorkspace:rounds*2+3*conflictRounds,
      confirmedStaleRefusals:conflicts.length,winningOperations:Object.fromEntries(['verify','deny-verification']
        .map(key=>[key,conflicts.filter(row=>row.operation===key).length])),noCrossWorkspaceLeakage:true,
      unchangedAfterRestart:true,unexpected5xx:observations.filter(o=>o.status>=500).length,httpCalls:observations.length,statuses,bulk,competing,
      totalMs:round(performance.now()-started)};
  }catch(error){
    throw Error('Client bound '+concurrency+' / '+phase+': '+error.message.split('\n')[0],{cause:error});
  }finally{
    await Promise.all([...peers].map(stop));
  }
}

async function main(){
  if(process.argv.length!==2)throw Error('This local experiment accepts no service, data, or credential parameters.');
  const root=await mkdtemp(join(tmpdir(),'trust-sqlite-concurrency-'));
  try{
    const serial=await trial(root,1),concurrent=await trial(root,4);
    for(const key of ['acknowledgedUniqueRows','confirmedStaleRefusals','rowsPerWorkspace','statuses'])
      assert.deepEqual(serial[key],concurrent[key]);
    console.log(JSON.stringify({node:process.versions.node,sqlite:process.versions.sqlite,fixture:'loopback synthetic only',
      serial,concurrent},null,2));
  }finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[2]==='--worker')worker();
else main().catch(error=>{console.error(error.message);process.exitCode=1;});
