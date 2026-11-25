'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,readdir,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const code=()=>randomBytes(32).toString('base64url');
async function serve(options){
  const server=createServer(options);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('synthetic requester opens one durable case and sees only its permitted public status',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-portal-'));
  let now=Date.now();
  const credentials={analyst:code(),reviewer:code(),requester:code(),other:code(),second:code()};
  const config={root,now:()=>now,
    workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:['analyst','reviewer'].map(role=>({id:role,codeHash:codeHash(credentials[role]),memberships:{alpha:role,beta:role}})),
    requesterGrants:[['requester','alpha'],['other','beta'],['second','alpha']].map(([id,workspace])=>({
      id,workspace,alias:'sample-'+id,codeHash:codeHash(credentials[id]),expiresAt:now+1000000
    })),
  };
  let live=await serve({isolated:config});
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  async function request(path,expect,{body,cookie,origin,actor}={}){
    const r=await fetch(live.url+path,{method:body===undefined?'GET':'POST',headers:{
      ...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin??live.url}),
      ...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{})
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload=r.headers.get('content-type')?.startsWith('application/json')?await r.json():await r.text();
    assert.equal(r.status,expect,JSON.stringify(payload));
    return {payload,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const portal='/api/requester/';
  const post=(action,body,expect=200)=>request(portal+action,expect,{body}).then(r=>r.payload);
  const login=async(account,workspace='alpha')=>(await request('/api/session/login',200,{body:{account,workspace,code:credentials[account]}})).cookie;
  const a=await login('analyst'),r=await login('reviewer'),b=await login('analyst','beta');
  assert.match((await request('/requester',200)).payload,/Synthetic privacy request portal/);
  await request(portal+'status',404);
  await request(portal+'intake',403,{body:{code:credentials.requester,kind:'access'},origin:'http://localhost:2'});
  await request(portal+'status',401,{body:{code:code()},cookie:a,actor:'analyst'});
  await post('status',{code:credentials.analyst},401);
  await post('status?workspace=beta',{code:credentials.requester},422);
  await post('intake',{code:credentials.requester,kind:'access',workspace:'beta'},422);
  await post('intake',{code:credentials.requester,kind:'access',email:'DO_NOT_STORE'},422);
  assert.equal((await post('status',{code:credentials.requester})).status,'not-submitted');
  await post('intake',{code:credentials.requester,kind:'different'},422);
  await post('intake',{code:credentials.requester,kind:null},422);
  assert.deepEqual(await readdir(join(root,'alpha')),[]);
  assert.deepEqual(await readdir(join(root,'beta')),[]);
  const open=await Promise.all(Array.from({length:5},()=>post('intake',{code:credentials.requester,kind:'access'})));
  const item=open[0];
  assert.ok(open.every(row=>row.receipt===item.receipt));
  assert.deepEqual(Object.keys(item).sort(),['mode','receipt','receivedDate','requestType','status'].sort());
  await post('intake',{code:credentials.requester,kind:'deletion'},409);
  const cases='/api/rights/cases';
  const readCases=async(cookie,workspace)=>(await request(cases+'?workspace='+workspace,200,{cookie})).payload.cases;
  assert.equal((await readCases(b,'beta')).length,0);
  const alpha=await readCases(a,'alpha');
  assert.equal(alpha.length,1);
  const row=alpha[0];
  assert.equal(row.source,'synthetic-portal');
  assert.equal(row.identity.status,'pending');
  assert.notEqual(row.id,item.receipt);
  assert.equal((await post('status',{code:credentials.other})).status,'not-submitted');
  assert.equal((await post('status',{code:credentials.second})).status,'not-submitted');
  await post('status',{code:item.receipt},401);
  await request('/api/rights/cases?workspace=alpha',401,{body:undefined});
  await post('status',{code:credentials.requester,caseId:row.id},422);
  const action=async (name,revision,cookie,expected=200,note='Operator-only synthetic text')=>
    (await request(cases+'/'+row.id+'/'+name+'?workspace=alpha',expected,{cookie,body:{expectedRevision:revision,note}})).payload;
  await action('begin',1,a,409);
  await action('verify',1,a,403);
  await action('verify',1,r);
  assert.deepEqual(await post('status',{code:credentials.requester}),item);
  await action('begin',2,a);
  assert.equal((await post('status',{code:credentials.requester})).status,'In progress');
  await action('fulfill',3,a);
  const closed=await post('status',{code:credentials.requester});
  assert.equal(closed.status,'Simulation complete');
  assert.doesNotMatch(JSON.stringify(closed),/Operator|sample-requester|analyst|reviewer|due|identity|caseId/i);
  const state=(await request('/api/state?workspace=alpha',200,{cookie:a})).payload;
  assert.equal(state.requesterReceipts,undefined);
  const audit=(await request('/api/audit/export?workspace=alpha',200,{cookie:r})).payload.audit;
  assert.equal(audit.filter(e=>e.action==='rights.case.opened').length,1);
  assert.equal(audit.filter(e=>e.action==='rights.case.portal-receipt-issued').length,1);
  assert.equal(audit.find(e=>e.action==='rights.case.verify').account,'reviewer');
  const persisted=await readFile(join(root,'alpha','state.json'),'utf8');
  assert.ok(Object.values(credentials).every(secret=>!persisted.includes(secret)));
  assert.doesNotMatch(persisted,/DO_NOT_STORE/);
  await live.close();live=await serve({isolated:config});
  assert.deepEqual(await post('status',{code:credentials.requester}),closed);
  assert.deepEqual(await post('intake',{code:credentials.requester,kind:'access'}),closed);
  await post('intake',{code:credentials.second,kind:'correction'});
  const updatedA=await login('analyst'),updatedR=await login('reviewer');
  const second=(await readCases(updatedA,'alpha')).find(c=>c.id!==row.id);
  for(const [name,cookie,expectedRevision] of [['deny-verification',updatedR,1],['close-unverified',updatedA,2]]){
    await request(cases+'/'+second.id+'/'+name+'?workspace=alpha',200,
      {cookie,body:{expectedRevision,note:'Internal-only simulated absence evidence'}});
  }
  const noDisclosure=await post('status',{code:credentials.second});
  assert.equal(noDisclosure.status,'Simulation closed without disclosure');
  assert.doesNotMatch(JSON.stringify(noDisclosure),/Internal-only|identity|evidence/);
  assert.deepEqual(await post('status',{code:credentials.requester}),closed);
  now+=1000000;
  await post('status',{code:credentials.requester},401);
  for(let i=0;i<30;i++)await post('status',{code:code()},i<29?401:429);
});
test('requester portal stays disabled in the ordinary demo',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-portal-demo-'));
  const live=await serve({dataFile:join(root,'state.json')});
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  assert.equal((await fetch(live.url+'/requester')).status,404);
  const r=await fetch(live.url+'/api/requester/intake',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':'analyst'},body:JSON.stringify({code:code(),kind:'access'})});
  assert.equal(r.status,404);
  assert.deepEqual((await (await fetch(live.url+'/api/rights/cases')).json()).cases,[]);
});
