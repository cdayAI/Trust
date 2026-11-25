'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readFile,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const {validateFixture}=require('../discovery-import');
const {getFixture}=require('../discovery-fixtures');

const library=version=>({source:'sample-library',version});
test('bounded fixture validation rejects unsupported sample and ambiguous metadata',()=>{
  assert.equal(validateFixture(getFixture('sample-library',2)).datasets.length,2);
  const wrong=mutation=>{
    const x=getFixture('sample-library',1);
    mutation(x);
    assert.throws(()=>validateFixture(x),{code:'INVALID_FIXTURE_SCHEMA'});
  };
  wrong(x=>{x.datasets[0].sampleRows=[['fictional omitted value']]});
  wrong(x=>{x.datasets[0].fields[0].value='fictional omitted value'});
  wrong(x=>{x.datasets[0].fields[1].id=x.datasets[0].fields[0].id});
  wrong(x=>{x.datasets[1].id=x.datasets[0].id});
  wrong(x=>{x.datasets[1].name=x.datasets[0].name.toUpperCase()});
  wrong(x=>{x.datasets[0].fields[0].type='unsupported'});
  wrong(x=>{x.datasets=Array.from({length:13},()=>x.datasets[0])});
});
async function serve(options){
  const server=createServer(options);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {
    url:'http://127.0.0.1:'+server.address().port,
    close:()=>new Promise(resolve=>server.close(resolve)),
  };
}
const scoped=(path,workspace)=>path+(workspace?'?workspace='+workspace:'');
async function http(url,path,expect,{workspace,body,cookie,actor}={}){
  const r=await fetch(url+scoped(path,workspace),body===undefined?{headers:cookie?{Cookie:cookie}:{}}:{
    method:'POST',headers:{Origin:url,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{})},
    body:JSON.stringify(body)
  });
  const data=await r.json();
  assert.equal(r.status,expect,JSON.stringify(data));
  return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const root='/api/data-map', discovery=root+'/discovery';
test('discovery preview has no writes, commit is atomic, repeat is idempotent and revisions preserve manual work',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'trust-import-test-'));
  const file=join(dir,'state.json');
  let live=await serve({dataFile:file});
  t.after(async()=>{await live.close();await rm(dir,{recursive:true,force:true})});
  const get=async(path,code=200)=>(await http(live.url,path,code)).data;
  const post=async(path,body,code=200,actor='analyst')=>(await http(live.url,path,code,{body,actor})).data;
  const plan=(version)=>post(discovery+'/preview',library(version));
  const apply=(preview,code=200)=>post(discovery+'/apply',{source:preview.source,version:preview.version,previewKey:preview.previewKey},code);
  const before=await readFile(file,'utf8');
  assert.equal((await get(discovery)).fixtures.length,3);
  assert.equal((await post(discovery+'/preview',{...library(1),sample:'DO_NOT_STORE_FIXTURE_VALUE'},422)).code,'INVALID_IMPORT_SELECTION');
  assert.equal((await post(discovery+'/preview',library(9),404)).code,'FIXTURE_NOT_FOUND');
  await post(discovery+'/preview',library(1),403,'reviewer');
  const preview=await plan(1);
  assert.equal(preview.mapRevision,0);
  assert.equal(preview.candidates.length,3);
  assert.equal(preview.links.length,2);
  assert.equal(preview.candidates.find(x=>x.sourceId==='reading-queue').provenance.fields[0].classification,'possible identifier');
  assert.ok(preview.candidates.every(x=>x.action==='create'));
  assert.equal(await readFile(file,'utf8'),before);
  assert.equal((await get(root)).nodes.length,0);
  const payload={source:preview.source,version:preview.version,previewKey:preview.previewKey};
  const parallel=await Promise.all([200,409].map(async()=>fetch(live.url+discovery+'/apply',{
    method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':'analyst'},body:JSON.stringify(payload)
  })));
  assert.deepEqual(parallel.map(r=>r.status).sort((a,b)=>a-b),[200,409]);
  const saved=await parallel.find(r=>r.ok).json();
  assert.deepEqual(saved.result,{createdNodes:3,refreshedNodes:0,createdLinks:2,mapRevision:1,changed:true});
  const queue=saved.map.nodes.find(x=>x.discovery.sourceId==='reading-queue');
  assert.ok(queue);
  assert.ok((await get(root+'/nodes/'+queue.id+'/lineage')).upstream.some(n=>n.type==='system'));
  const beforeRepeat=await readFile(file,'utf8');
  const repeat=await apply(await plan(1));
  assert.deepEqual(repeat.result,{createdNodes:0,refreshedNodes:0,createdLinks:0,mapRevision:1,changed:false});
  assert.equal(await readFile(file,'utf8'),beforeRepeat);
  const upgrade=await plan(2);
  await post(root+'/nodes/'+queue.id+'/update',{
    expectedRevision:1,name:'Editorial dataset name',owner:'Fictional Data Team',detail:'Manual documentation to preserve.'
  });
  assert.equal((await apply(upgrade,409)).code,'STALE_PREVIEW');
  const upgraded=await apply(await plan(2));
  assert.equal(upgraded.result.refreshedNodes,3);
  const next=upgraded.map.nodes.find(n=>n.id===queue.id);
  assert.equal(next.discovery.version,2);
  assert.equal(next.discovery.fields.length,3);
  assert.equal(next.discoveryHistory[0].version,1);
  assert.equal(next.name,'Editorial dataset name');
  assert.equal(next.owner,'Fictional Data Team');
  assert.equal(next.detail,'Manual documentation to preserve.');
  const rollback=await plan(1);
  assert.ok(rollback.conflicts.some(c=>c.reason.includes('newer')));
  assert.equal((await apply(rollback,409)).code,'IMPORT_CONFLICT');
  const map=await post(root+'/nodes',{type:'system',name:'Fictional Seed Library',owner:'Analyst',detail:'Manual metadata',expectedRevision:3});
  const conflict=await post(discovery+'/preview',{source:'sample-garden',version:1});
  assert.ok(conflict.conflicts.some(c=>c.reason.includes('already uses this name')));
  assert.equal((await apply(conflict,409)).code,'IMPORT_CONFLICT');
  assert.deepEqual(await get(root),map);
  const exported=await get(root+'/export');
  assert.ok(exported.audit.some(e=>e.action==='data-map.import.refused'));
  assert.equal(exported.audit.filter(e=>e.action==='data-map.import.applied').length,2);
  assert.doesNotMatch(await readFile(file,'utf8'),/DO_NOT_STORE_FIXTURE_VALUE|previewKey/);
  assert.doesNotMatch(JSON.stringify(exported),/DO_NOT_STORE_FIXTURE_VALUE|previewKey/);
  await live.close();live=await serve({dataFile:file});
  assert.deepEqual(await get(root+'/export'),exported);
  assert.equal((await apply(await plan(2))).result.changed,false);
});
test('isolated discovery preview and persisted metadata never cross verified workspace membership',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'trust-import-scope-'));
  const access=randomBytes(32).toString('base64url');
  const live=await serve({isolated:{root:dir,workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:[{id:'fixture-owner',codeHash:codeHash(access),memberships:{alpha:'analyst',beta:'analyst'}}]}});
  t.after(async()=>{await live.close();await rm(dir,{recursive:true,force:true})});
  await http(live.url,discovery,401,{workspace:'alpha'});
  const login=async workspace=>(await http(live.url,'/api/session/login',200,{body:{account:'fixture-owner',workspace,code:access}})).cookie;
  const a=await login('alpha'),b=await login('beta');
  const post=(path,code,cookie,workspace,body)=>http(live.url,discovery+path,code,{cookie,workspace,body});
  const {data:plan}=await post('/preview',200,a,'alpha',library(1));
  assert.deepEqual(await readdir(join(dir,'alpha')),[]);
  await post('/preview',403,a,'beta',library(1));
  const body={...library(1),previewKey:plan.previewKey};
  await post('/apply',403,a,'beta',body);
  assert.equal((await post('/apply',409,b,'beta',body)).data.code,'STALE_PREVIEW');
  await post('/apply',200,a,'alpha',body);
  const get=(workspace,cookie)=>http(live.url,root+'/export',200,{workspace,cookie});
  const exported=await get('alpha',a);
  assert.equal(exported.data.graph.nodes.length,3);
  assert.equal(exported.data.audit.find(e=>e.action==='data-map.import.applied').account,'fixture-owner');
  const other=await get('beta',b);
  assert.equal(other.data.graph.nodes.length,0);
  assert.ok(other.data.audit.every(e=>e.action==='data-map.import.refused'));
  assert.doesNotMatch(JSON.stringify(other.data),/reading-queue|Fictional Reading/);
});

test('import honors deliberate link archival and never recreates an archived relationship',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'trust-import-archive-'));
  const live=await serve({dataFile:join(dir,'state.json')});
  t.after(async()=>{await live.close();await rm(dir,{recursive:true,force:true})});
  const post=async(path,body,expect=200)=>(await http(live.url,path,expect,{body,actor:'analyst'})).data;
  const plan=(version)=>post(discovery+'/preview',library(version));
  const apply=(p,expect)=>post(discovery+'/apply',{...library(p.version),previewKey:p.previewKey},expect);
  const first=(await apply(await plan(1))).map;
  const archived=await post(root+'/links/'+first.links[0].id+'/archive',{expectedRevision:first.revision,note:'Fictional conscious archival'});
  const next=await plan(2);
  assert.ok(next.conflicts.some(c=>c.reason.includes('deliberately archived')));
  assert.equal((await apply(next,409)).code,'IMPORT_CONFLICT');
  assert.deepEqual((await http(live.url,root,200)).data,archived);
});
