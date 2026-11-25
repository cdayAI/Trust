'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {once}=require('node:events');
const {spawnSync}=require('node:child_process');
const {createServer}=require('../server');
const {openSqlite}=require('../durable-storage');
const {codeHash}=require('../workspace-access');
const {view:queue}=require('../work-queue');

async function running(t,options){
  const server=createServer(options).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  });
  const origin='http://127.0.0.1:'+server.address().port;
  return async (route,status,{body,cookie}={})=>{
    const response=await fetch(origin+'/api/'+route,{
      method:body===undefined?'GET':'POST',
      headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{origin,'content-type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(5000)
    });
    const value=await response.json();
    assert.equal(response.status,status,JSON.stringify(value));
    return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
}

test('SQLite generation reads distinguish missing/unchanged state and see only committed changes across connections',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'trust-generations-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=join(folder,'generation.sqlite');
  const writer=openSqlite(file);
  try{
    writer.requireMode('demo');
    const readDb=openSqlite(file,{readOnly:true});
    try{
      const reading=readDb.scope('demo'),writing=writer.scope('demo');
      const policy={schemaVersion:1,definitions:[],instances:[],events:[]};
      assert.deepEqual(reading.readSince('workflow',-1),{generation:0});
      writing.write('workflow',(_,save)=>save(policy));
      assert.deepEqual(reading.readSince('workflow',0),{generation:1,payload:policy});
      assert.deepEqual(reading.readSince('workflow',1),{generation:1});
      assert.throws(()=>writing.write('workflow',(snapshot,save)=>{
        save({...snapshot,events:[{id:'rolled-back-local-event'}]});
        assert.deepEqual(reading.readSince('workflow',1),{generation:1});
        throw Error('Synthetic rollback');
      }),/Synthetic rollback/);
      assert.deepEqual(reading.readSince('workflow',1),{generation:1});
      const next={...policy,events:[{id:'committed-local-event'}]};
      writing.write('workflow',(_,save)=>save(next));
      assert.deepEqual(reading.readSince('workflow',1),{generation:2,payload:next});
      assert.deepEqual(reading.readSince('workflow',2),{generation:2});
      assert.throws(()=>reading.readSince('workflow',Infinity),/generation/);
    } finally {readDb.close();}
  } finally {writer.close();}
});

test('warm isolated session/role lookups see remote SQLite identity revocation immediately',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'trust-membership-generations-'));
  const roles=['identity-admin','analyst'];
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const options={dataFile:join(folder,'demo.json'),sqliteFile:join(folder,'state.sqlite'),isolated:{
    root:join(folder,'workspaces'),enableIdentityAdmin:true,
    workspaces:[{id:'alpha',label:'Synthetic Alpha'},{id:'beta',label:'Synthetic Beta'}],
    accounts:roles.map(role=>({id:'sample-'+role,codeHash:codeHash(codes[role]),memberships:{alpha:role,beta:role}}))
  }};
  const siteA=await running(t,options),siteB=await running(t,options);
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const login=(site,role,workspace='alpha',status=200)=>site('session/login',status,{body:{account:'sample-'+role,code:codes[role],workspace}});
  const beta=await login(siteA,'analyst','beta');
  const analyst=await login(siteA,'analyst');
  const admin=await login(siteB,'identity-admin');
  const body={target:'sample-analyst',operation:'disable',reason:'access-review',expectedRevision:0};
  await siteA('reporting?workspace=alpha',200,analyst);
  await siteA('reporting?workspace=alpha',200,analyst);
  await siteB('identity-admin?workspace=alpha',200,{cookie:admin.cookie,body});
  await siteA('reporting?workspace=alpha',401,analyst);
  await siteA('reporting?workspace=beta',200,beta);
  await login(siteA,'analyst','alpha',401);
  await siteB('identity-admin?workspace=alpha',200,{cookie:admin.cookie,body:{...body,operation:'enable',expectedRevision:1}});
  await siteA('reporting?workspace=alpha',401,analyst);
  await siteA('reporting?workspace=alpha',200,await login(siteA,'analyst'));
});

test('queue early filters preserve filtered rows, sorted order and aggregate counts',()=>{
  const sample={actors:[{id:'analyst'},{id:'reviewer'},{id:'case-operator'}],vendors:[{id:'sample-vendor',name:'Fictional vendor'}],
    assessments:[{id:'draft-assessment',vendorId:'sample-vendor',projectId:'project',status:'draft'}],
    incidentCases:[{id:'review-incident',stage:'review',title:'Fictional incident'}],
    rightsCases:[
      {id:'a',kind:'access',owner:'case-operator',identity:{status:'pending'},dueDate:'2026-01-02'},
      {id:'b',kind:'correction',owner:'case-operator',identity:{status:'verified'},status:'received',dueDate:'2026-01-01'},
      {id:'c',kind:'deletion',owner:'analyst',identity:{status:'pending'},dueDate:'2026-01-02'},
      {id:'d',kind:'access',owner:'case-operator',identity:{status:'pending'},dueDate:'2026-01-03'}
    ]};
  const today='2026-01-02';
  const all=queue(sample,new URLSearchParams(),today);
  assert.equal(all.counts.total,6);
  assert.deepEqual(all.tasks.map(x=>x.sourceId),['b','a','c','d','draft-assessment','review-incident']);
  for(const owner of ['all','reviewer','case-operator','analyst'])
    for(const workflow of ['all','assessments','incidents','rights','vendor-monitoring'])
      for(const timing of ['all','overdue','due-today','no-date','upcoming']){
        const filters=new URLSearchParams({owner,workflow,timing});
        const out=queue(sample,filters,today);
        const expected=all.tasks.filter(task=>(owner==='all'||task.owner===owner)&&
          (workflow==='all'||task.workflow===workflow)&&(timing==='all'||task.timing===timing));
        assert.deepEqual(out.tasks,expected);
        assert.equal(out.counts.total,expected.length);
        assert.equal(out.counts.overdue,expected.filter(x=>x.timing==='overdue').length);
        assert.equal(out.counts.dueToday,expected.filter(x=>x.timing==='due-today').length);
        for(const [name,count] of Object.entries(out.counts.byWorkflow))
          assert.equal(count,expected.filter(x=>x.workflow===name).length);
      }
  assert.throws(()=>queue(sample,new URLSearchParams('owner=all&owner=analyst'),today),/filter/);
});

test('benchmark uses bounded fixtures, returns a complete result, and rejects external destinations',()=>{
  const cwd=join(__dirname,'..');
  const env={...process.env,DATA_FILE:join(__dirname,'not-a-benchmark-state'),TRUST_SQLITE_FILE:join(__dirname,'not-a-benchmark-sqlite'),PORT:'65535'};
  const args=['scripts/benchmark-local.js','--records','8','--samples','8','--concurrency','2'];
  const result=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',timeout:18000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const summary=JSON.parse(result.stdout);
  assert.deepEqual(summary.results.map(({backend,mode})=>[backend,mode]),
    [['json','demo'],['json','isolated'],['sqlite','demo'],['sqlite','isolated']]);
  for(const set of summary.results){
    assert.equal(set.writes,12);
    assert.ok(set.seedUtf8Bytes>0);
    for(const row of set.metrics)
      assert.ok(row.samples===8&&row.p50Ms>=0&&row.p50Ms<=row.p95Ms&&row.p95Ms<=row.p99Ms&&row.lastResponseBytes>0);
  }
  for(const extra of [['--records','1501'],['--concurrency','0'],['--url','https://example.invalid']]){
    const denied=spawnSync(process.execPath,['scripts/benchmark-local.js',...extra],{cwd,encoding:'utf8',timeout:5000});
    assert.equal(denied.status,1);
    assert.match(denied.stderr,/^Usage:/);
  }
});
