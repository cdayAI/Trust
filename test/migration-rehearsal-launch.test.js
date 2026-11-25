'use strict';

const assert=require('node:assert/strict');
const {execFile,spawn}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,readdir,rm,stat,writeFile}=require('node:fs/promises');
const http=require('node:http');
const {tmpdir}=require('node:os');
const {dirname,join,resolve}=require('node:path');
const {test}=require('node:test');
const {promisify}=require('node:util');
const {openSqlite}=require('../durable-storage');

const app=resolve(__dirname,'..');
const cli=join(app,'storage-cli.js'),launcher=join(app,'start-migration-rehearsal.js');
const source=join(app,'fixtures','fictional-transfer-v1.json');
const workspace='migration-fixture-receiving';
const run=promisify(execFile);
const time=16000;
async function room(t){
  const path=await mkdtemp(join(tmpdir(),'test-migration-rehearsal-'));
  t.after(()=>rm(path,{recursive:true,force:true,maxRetries:2}));
  const env={...process.env,TMPDIR:path,TMP:path,TEMP:path,PORT:'1',DATA_FILE:join(path,'ignored-state.json'),
    TRUST_SQLITE_FILE:join(path,'ignored.sqlite')};
  const execute=(script,args)=>run(process.execPath,[script,...args],{cwd:path,env,timeout:time});
  const storage=async(...args)=>JSON.parse((await execute(cli,args)).stdout);
  const plan=join(path,'reviewed.json'),database=join(path,'original.sqlite');
  const dryRun=await storage('plan-fixture-import',source,workspace,plan);
  const receipt=await storage('import-fixture',source,plan,database,'--confirm',dryRun.planDigest);
  const args=[source,plan,database,'--confirm',receipt.receiptId];
  return {path,env,execute,storage,plan,database,dryRun,receipt,args};
}
async function start(t,f){
  const child=spawn(process.execPath,[launcher,...f.args],{cwd:f.path,env:f.env,stdio:['ignore','pipe','pipe']});
  let stderr='',stdout='',timer;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>stderr+=chunk);
  const done=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  done.catch(()=>{});
  const stop=async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    return done;
  };
  t.after(stop);
  const ready=await Promise.race([
    new Promise(resolve=>child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n'))resolve(JSON.parse(stdout.trim()));})),
    done.then(()=>{throw new Error('Rehearsal exited before readiness: '+stderr);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Rehearsal launcher timed out.')),time);}),
  ]).finally(()=>clearTimeout(timer));
  return {ready,stop,console:()=>stdout+stderr};
}
test('launcher preflight only accepts the exact reviewed untouched fixture, plan and receipt',async t=>{
  const f=await room(t);
  const original=await readFile(f.database),entries=(await readdir(f.path)).sort();
  const success=await f.execute(launcher,[...f.args,'--check']);
  assert.deepEqual(JSON.parse(success.stdout),{status:'verified',mode:'fictional-migration-rehearsal',workspace,sourceRetained:true,editableCopy:false});
  assert.deepEqual((await readdir(f.path)).sort(),entries);
  const refused=args=>assert.rejects(f.execute(launcher,args),error=>
    error.code===1&&error.stdout===''&&error.stderr.includes('untouched verified fictional import'));
  await refused([...f.args.slice(0,4),'0'.repeat(64),'--check']);
  await assert.rejects(f.execute(launcher,[...f.args,'--host','0.0.0.0']),error=>error.code===1&&error.stderr.startsWith('Usage:'));
  const occupied=http.createServer().listen(0,'127.0.0.1');
  await once(occupied,'listening');
  try{
    await refused([...f.args,'--port',String(occupied.address().port),'--check']);
  }finally{await new Promise(resolve=>occupied.close(resolve));}
  assert.deepEqual(await readFile(f.database),original);
  assert.deepEqual((await readdir(f.path)).sort(),entries);

  const drifted=join(f.path,'drifted.sqlite');
  const driftReceipt=await f.storage('import-fixture',source,f.plan,drifted,'--confirm',f.dryRun.planDigest);
  const storage=openSqlite(drifted);
  try{storage.scope('workspace:'+workspace).write('workbench',(state,save)=>save(state));}finally{storage.close();}
  const driftBytes=await readFile(drifted);
  await refused([source,f.plan,drifted,'--confirm',driftReceipt.receiptId,'--check']);
  assert.deepEqual(await readFile(drifted),driftBytes);
  const changed=join(f.path,'different-plan.json');
  await writeFile(changed,JSON.stringify({...f.dryRun,workspace:'migration-somewhere-else'}));
  await refused([source,changed,f.database,'--confirm',f.receipt.receiptId,'--check']);
  assert.deepEqual(await readFile(f.database),original);
  assert.ok(!(await readdir(f.path)).some(x=>x.startsWith('mvw-migration-rehearsal-')));
});
test('real receiving copy supports separately authenticated review/edit without changing source or retaining credentials',async t=>{
  const f=await room(t);
  const before={database:await readFile(f.database),plan:await readFile(f.plan),fixture:await readFile(source)};
  const launch=await start(t,f);
  const {ready,stop}=launch;
  assert.equal(ready.status,'ready');
  assert.equal(ready.sourceRetained,true);
  assert.equal(ready.editableCopy,true);
  assert.equal(ready.workspace,workspace);
  assert.equal(dirname(ready.runDirectory),f.path);
  assert.match(ready.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const access=JSON.parse(await readFile(ready.accessFile,'utf8'));
  assert.equal(access.workspace,workspace);
  assert.equal(access.staff.length,2);
  assert.notEqual(access.staff[0].code,access.staff[1].code);
  if(process.platform!=='win32'){
    assert.equal((await stat(ready.runDirectory)).mode&0o777,0o700);
    assert.equal((await stat(ready.accessFile)).mode&0o777,0o600);
  }
  assert.ok(access.staff.every(seat=>!launch.console().includes(seat.code)));
  const req=async(path,status,{body,cookie,scope}={})=>{
    const response=await fetch(ready.url+path+(scope?'?workspace='+scope:''),{
      redirect:'error',signal:AbortSignal.timeout(6500),
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:ready.url,'Content-Type':'application/json'})},
    });
    assert.equal(response.status,status,path);
    return {data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async role=>{
    const seat=access.staff.find(seat=>seat.memberships[workspace]===role);
    return (await req('/api/session/login',200,{body:{account:seat.id,workspace,code:seat.code}})).cookie;
  };
  const a=await login('analyst'),r=await login('reviewer');
  await req('/api/dictionary',401,{scope:workspace});
  await req('/api/dictionary',403,{scope:'migration-another-fixture',cookie:a});
  for(const path of ['/rehearsal-access.json','/rehearsal.sqlite','/requester','/employee','/training'])
    await req(path,404);
  const api=(path,status,cookie,body)=>req(path,status,{cookie,body,scope:workspace}).then(x=>x.data);
  assert.equal((await req('/health/ready',200)).data.status,'ready');
  const known=await api('/api/data-map',200,a);
  assert.deepEqual(known.nodes.map(row=>row.id),f.dryRun.map.nodes.map(row=>row.id));
  assert.deepEqual(known.links.map(row=>row.id),f.dryRun.map.links.map(row=>row.id));
  const {terms}=await api('/api/dictionary',200,a);
  assert.ok(terms.every(term=>term.activeVersion===null&&term.consumers.length===0));
  const term=terms.find(x=>x.type==='sensitivity'),node=known.nodes.find(x=>x.type==='dataset');
  const item='/api/dictionary/terms/'+term.id;
  await api(item+'/submit',200,a,{expectedRevision:1,version:1});
  await api(item+'/approve',403,a,{expectedRevision:2,version:1});
  await api(item+'/approve',200,r,{expectedRevision:2,version:1});
  const attached=await api(item+'/attach',200,a,{expectedRevision:3,expectedMapRevision:1,nodeId:node.id,version:1});
  assert.equal(attached.terms.find(x=>x.id===term.id).consumers[0].nodeId,node.id);
  const updatedAudit=(await api('/api/audit/export',200,r)).audit;
  assert.equal(updatedAudit[0].details.planDigest,f.dryRun.planDigest);
  assert.ok(updatedAudit.some(entry=>entry.action==='dictionary.approve'&&entry.actor==='reviewer'));
  assert.deepEqual(await readFile(f.database),before.database);
  assert.deepEqual(await readFile(f.plan),before.plan);
  assert.deepEqual(await readFile(source),before.fixture);
  const original=await f.storage('verify-fixture-import',source,f.plan,f.database,'--confirm',f.receipt.receiptId);
  assert.equal(original.status,'verified');
  await stop();
  if(process.platform!=='win32')await assert.rejects(stat(ready.runDirectory),{code:'ENOENT'});
  const replay=await start(t,f);
  const replayAccess=JSON.parse(await readFile(replay.ready.accessFile,'utf8'));
  assert.notEqual(replay.ready.runDirectory,ready.runDirectory);
  assert.ok(replayAccess.staff.every(seat=>!access.staff.some(previous=>previous.code===seat.code)));
  await replay.stop();
  await f.execute(launcher,[...f.args,'--check']);
});
