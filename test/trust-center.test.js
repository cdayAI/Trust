'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm,readdir}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const newCode=()=>randomBytes(32).toString('base64url');
async function launch(options){
  const server=createServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('only exact independently reviewed copy reaches the correct local visitor site',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-center-test-'));
  const codes={analyst:newCode(),reviewer:newCode()};
  const isolated={root,workspaces:[{id:'a',label:'A'},{id:'b',label:'B'},{id:'c',label:'C'}],
    accounts:Object.keys(codes).map(id=>({id,codeHash:codeHash(codes[id]),memberships:{a:id,b:id,c:id}})),
    trustCenters:[{slug:'sample-alpha',workspace:'a'},{slug:'sample-beta',workspace:'b'}]};
  let live=await launch({isolated});
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  const rootApi='/api/trust-center';
  async function request(path,expect,{cookie,body,actor}={}){
    const r=await fetch(live.url+path,{
      method:body===undefined?'GET':'POST',headers:{
        ...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{}),
        ...(body===undefined?{}:{'Content-Type':'application/json',Origin:live.url})
      },...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=r.headers.get('content-type')?.startsWith('application/json')?await r.json():await r.text();
    assert.equal(r.status,expect,JSON.stringify(data));
    assert.equal(r.headers.get('cache-control'),'no-store');
    return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(id,workspace)=>(await request('/api/session/login',200,{body:{account:id,workspace,code:codes[id]}})).cookie;
  const readVisitor=async (slug='sample-alpha',cookie)=>(await request('/api/trust-center-visitor/'+slug,200,{cookie})).data;
  const empty={title:'Synthetic trust center',cards:[]};
  assert.deepEqual(await readVisitor(),empty);
  assert.deepEqual(await readdir(join(root,'a')),[]);
  assert.match((await request('/trust-center/sample-alpha',200)).data,/LOCAL VISITOR PREVIEW/);
  await request('/api/trust-center-visitor/sample-alpha?workspace=b',404);
  await request('/trust-center/sample-other',404);
  await request('/api/trust-center-visitor/sample-other',404);
  await request('/api/trust-center-visitor/sample-alpha',404,{body:{}});
  await request(rootApi+'?workspace=a',401);
  const a=await login('analyst','a'),b=await login('analyst','b'),r=await login('reviewer','a'),c=await login('analyst','c');
  await request(rootApi+'?workspace=b',403,{cookie:a});
  assert.deepEqual((await request(rootApi+'?workspace=c',200,{cookie:c})).data,{enabled:false});
  const action=async(name,cookie,body,expected=200,workspace='a',actor)=>
    (await request(rootApi+'/privacy/'+name+'?workspace='+workspace,expected,{cookie,body,actor})).data;
  assert.equal((await action('draft',a,{expectedRevision:0,option:'overview'},403,'b')).error,'This request does not match the active workspace.');
  await action('draft',c,{expectedRevision:0,option:'overview'},404,'c');
  await action('draft',a,{expectedRevision:0,option:'overview',content:'REJECTED_PUBLIC_OVERRIDE'},422);
  const draft=await action('draft',a,{expectedRevision:0,option:'overview'});
  assert.equal(draft.visitorPath,'/trust-center/sample-alpha');
  assert.deepEqual(await readVisitor(),empty);
  const revision=(expectedRevision,version=1)=>({expectedRevision,version});
  await action('publish',a,revision(1),409);
  await action('submit',a,revision(1));
  await action('approve',a,revision(2),403,'a','reviewer');
  await action('return',r,{...revision(2),note:'INTERNAL_RETURN_ONLY'});
  await action('publish',a,revision(3),409);
  assert.deepEqual(await readVisitor('sample-alpha',r),empty);
  await action('draft',a,{expectedRevision:3,option:'review'});
  await action('submit',a,revision(4,2));
  await action('approve',r,revision(5,2));
  assert.deepEqual(await readVisitor(),empty);
  await action('publish',a,revision(5,2),409);
  const published=await action('publish',a,revision(6,2));
  const visible=await readVisitor();
  assert.deepEqual(visible,{title:'Synthetic trust center',cards:[{
    heading:'Privacy practices',description:published.catalog.privacy.options.review
  }]});
  assert.deepEqual(await readVisitor('sample-beta',b),empty);
  assert.deepEqual(await readVisitor('sample-alpha',b),visible);
  assert.doesNotMatch(JSON.stringify(visible),/INTERNAL|reviewer|"status"|"version"|"id"|"hash"/);
  await action('draft',a,{expectedRevision:7,option:'overview'});
  await action('submit',a,revision(8,3));
  await action('approve',r,revision(9,3));
  assert.deepEqual(await readVisitor(),visible);
  const superseded=await action('publish',a,revision(10,3));
  const fixed=superseded.topics.privacy.versions;
  assert.equal(fixed[1].status,'superseded');
  assert.deepEqual(fixed[1].card,published.topics.privacy.versions[1].card);
  assert.notDeepEqual(await readVisitor(),visible);
  await action('withdraw',a,{...revision(11,2),note:'Wrong version'},409);
  await action('withdraw',r,{...revision(11,3),note:'Wrong role'},403);
  const withdrawn=await action('withdraw',a,{...revision(11,3),note:'INTERNAL_WITHDRAWAL'});
  assert.deepEqual(await readVisitor(),empty);
  await action('publish',a,revision(12,2),409);
  const state=(await request('/api/state?workspace=a',200,{cookie:a})).data;
  assert.equal(state.trustCenter,undefined);
  const audit=(await request('/api/audit/export?workspace=a',200,{cookie:a})).data.audit;
  assert.ok(audit.some(e=>e.action==='trust-center.approve'&&e.account==='reviewer'));
  assert.ok(audit.some(e=>e.action==='trust-center.withdraw'&&e.account==='analyst'));
  assert.doesNotMatch(JSON.stringify(audit),/REJECTED_PUBLIC_OVERRIDE/);
  await live.close();live=await launch({isolated});
  assert.deepEqual(await readVisitor(),empty);
  const reopened=await login('analyst','a');
  assert.deepEqual((await request(rootApi+'?workspace=a',200,{cookie:reopened})).data,withdrawn);
});
test('the default demo cannot publish or serve visitor sites',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-center-demo-'));
  const live=await launch({dataFile:join(root,'state.json')});
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  assert.equal((await fetch(live.url+'/trust-center/sample-alpha')).status,404);
  const response=await fetch(live.url+'/api/trust-center/privacy/draft',{
    method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':'analyst'},body:JSON.stringify({expectedRevision:0,option:'overview'})
  });
  assert.equal(response.status,404);
});
