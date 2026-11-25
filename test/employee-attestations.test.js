'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes,createHmac}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,rm,readFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
async function start(options){
  const s=createServer(options);
  s.listen(0,'127.0.0.1');await once(s,'listening');
  return {url:'http://127.0.0.1:'+s.address().port,close:()=>new Promise(resolve=>s.close(resolve))};
}
test('assign and attest only a scoped published edition, once, with a durable version-bound receipt',async t=>{
  const root=await mkdtemp(join(tmpdir(),'employee-qa-'));
  const codes=Object.fromEntries(['author','reviewer','first','second','third'].map(x=>[x,randomBytes(32).toString('base64url')]));
  const key=randomBytes(32).toString('hex');
  let now=Date.now();
  const isolated={
    root,now:()=>now,workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:[['author','analyst'],['reviewer','reviewer']].map(([id,role])=>({id,codeHash:codeHash(codes[id]),memberships:{alpha:role,beta:role}})),
    employeeSigningKey:key,
    employeeGrants:[['first','alpha'],['second','alpha'],['third','beta']].map(([id,workspace])=>({
      alias:'sample-staff-'+id,workspace,codeHash:codeHash(codes[id]),expiresAt:now+3600000
    })),
  };
  let live=await start({isolated});t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  const admin='/api/employee-attestations';
  async function req(path,expected,{body,cookie,workspace,origin,actor}={}){
    const res=await fetch(live.url+path+(workspace?'?workspace='+workspace:''),{
      method:body===undefined?'GET':'POST',headers:{
        ...(body===undefined?{}:{Origin:origin??live.url,'Content-Type':'application/json'}),
        ...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{})
      },...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=res.headers.get('content-type')?.startsWith('application/json')?await res.json():await res.text();
    assert.equal(res.status,expected,JSON.stringify(data));
    return {data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(id,workspace)=>(await req('/api/session/login',200,{body:{account:id,workspace,code:codes[id]}})).cookie;
  const a=await login('author','alpha'),r=await login('reviewer','alpha'),b=await login('author','beta');
  const docs='/api/governance-documents';
  const mutateDoc=async(owner,path,body)=>(await req(docs+path,200,{workspace:'alpha',cookie:owner,body})).data;
  async function portal(id,operation='assignments',body={},status=200){
    return (await req('/api/employee/'+operation,status,{body:{code:codes[id],...body}})).data;
  }
  assert.match((await req('/employee',200)).data,/Synthetic employee policy portal/);
  await req(admin,401,{workspace:'alpha'});
  const first=(await mutateDoc(a,'/records',{kind:'policy',title:'Fictional policy',content:'Synthetic statement in edition one.',links:[],expectedRevision:0})).documents[0];
  const v=first.revisions[0];
  const grant={employee:'sample-staff-first',document:first.id,edition:v.id,hash:v.contentHash};
  const assign=async(cookie,body,status=200,workspace='alpha')=>(await req(admin,status,{cookie,workspace,body,actor:'analyst'})).data;
  assert.equal((await assign(a,grant,404)).code,'EDITION_NOT_FOUND');
  assert.deepEqual((await portal('first')).assignments,[]);
  assert.deepEqual((await portal('second')).assignments,[]);
  const revision='/records/'+first.id+'/revisions/'+v.id;
  await mutateDoc(a,revision+'/submit',{expectedRevision:1});
  await mutateDoc(r,revision+'/publish',{expectedRevision:2,note:'INTERNAL REVIEW TEXT'});
  assert.equal((await assign(r,grant,403)).code,'ATTESTATION_ANALYST');
  assert.equal((await assign(a,grant,403,'beta')).error,'This request does not match the active workspace.');
  assert.equal((await assign(b,{...grant,employee:'sample-staff-third'},404,'beta')).code,'EDITION_NOT_FOUND');
  assert.equal((await assign(a,{...grant,employee:'sample-staff-third'},404)).code,'EMPLOYEE_NOT_FOUND');
  assert.equal((await assign(a,{...grant,hash:'wrong'},409)).code,'EDITION_MISMATCH');
  const before=(await req(admin,200,{cookie:r,workspace:'alpha'})).data;
  assert.equal(before.editions.length,1);
  assert.doesNotMatch(JSON.stringify(before),/INTERNAL REVIEW TEXT|Synthetic statement/);
  const saved=await assign(a,grant);
  assert.deepEqual(await assign(a,grant),saved);
  const visible=(await portal('first')).assignments[0];
  assert.equal(visible.text,'Synthetic statement in edition one.');
  assert.equal(visible.receipt,null);
  assert.doesNotMatch(JSON.stringify(visible),/INTERNAL REVIEW TEXT|publishedBy|links|sample-staff/);
  assert.deepEqual((await portal('second')).assignments,[]);
  assert.deepEqual((await portal('third')).assignments,[]);
  await req('/api/employee/assignments',401,{body:{code:codes.author},cookie:a});
  await req('/api/employee/assignments',403,{body:{code:codes.first},origin:'http://localhost:1'});
  await req('/api/employee/assignments',422,{body:{code:codes.first},workspace:'beta'});
  const confirm={assignment:visible.assignment,edition:visible.edition,hash:visible.hash,confirm:true};
  await portal('second','attest',confirm,404);
  await portal('third','attest',confirm,404);
  await portal('first','attest',{...confirm,hash:'wrong'},409);
  await portal('first','attest',{...confirm,confirm:false},422);
  const receipts=await Promise.all(Array.from({length:4},()=>portal('first','attest',confirm)));
  const receipt=receipts[0].assignments[0].receipt;
  assert.ok(receipts.every(x=>x.assignments[0].receipt.receipt===receipt.receipt));
  const signed={receipt:receipt.receipt,assignment:visible.assignment,employee:grant.employee,edition:v.id,hash:v.contentHash,acknowledgedAt:receipt.acknowledgedAt};
  assert.equal(receipt.signature,createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(signed)).digest('hex'));
  const newer=(await mutateDoc(a,'/records/'+first.id+'/revise',{title:'Fictional revision two',content:'Synthetic statement in edition two.',links:[],expectedRevision:3})).documents[0].revisions.at(-1);
  const nextRev='/records/'+first.id+'/revisions/'+newer.id;
  await mutateDoc(a,nextRev+'/submit',{expectedRevision:4});
  await mutateDoc(r,nextRev+'/publish',{expectedRevision:5,note:'SECOND INTERNAL DECISION'});
  assert.equal((await portal('first')).assignments.length,1);
  await assign(a,{...grant,edition:newer.id,hash:newer.contentHash});
  const list=(await portal('first')).assignments;
  assert.equal(list.length,2);
  assert.equal(list[0].text,'Synthetic statement in edition one.');
  assert.deepEqual(list[0].receipt,receipt);
  assert.equal(list[1].receipt,null);
  await portal('first','attest',{...confirm,assignment:list[1].assignment},409);
  const global=(await req('/api/state',200,{cookie:a,workspace:'alpha'})).data;
  assert.equal(global.employeeAttestations,undefined);
  const events=(await req('/api/audit/export',200,{cookie:a,workspace:'alpha'})).data.audit;
  assert.equal(events.filter(e=>e.action==='employee-attestations.assigned').length,2);
  assert.equal(events.filter(e=>e.action==='employee-attestations.acknowledged').length,1);
  const file=await readFile(join(root,'alpha','state.json'),'utf8');
  assert.ok([...Object.values(codes),key].every(secret=>!file.includes(secret)));
  await live.close();live=await start({isolated});
  assert.deepEqual((await portal('first')).assignments,list);
  now+=3600000;
  await portal('first','assignments',{},401);
  const refreshed=await login('reviewer','alpha');
  const history=(await req(admin,200,{cookie:refreshed,workspace:'alpha'})).data;
  assert.deepEqual(history.staff,[]);
  assert.equal(history.assignments.length,2);
});
test('employee portal is disabled by default and rejects conflicting provisioned codes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'employee-no-provision-'));
  const live=await start({dataFile:join(root,'demo.json')});
  t.after(async()=>{await live.close();await rm(root,{recursive:true,force:true})});
  assert.equal((await fetch(live.url+'/employee')).status,404);
  const hash=randomBytes(32).toString('hex');
  assert.throws(()=>createServer({isolated:{
    root:join(root,'isolated'),workspaces:[{id:'alpha',label:'Alpha'}],employeeSigningKey:randomBytes(32).toString('hex'),
    accounts:[{id:'analyst',codeHash:hash,memberships:{alpha:'analyst'}}],
    employeeGrants:[{alias:'sample-staff-name',workspace:'alpha',codeHash:hash,expiresAt:Date.now()+3600000}]
  }}),/Invalid synthetic employee seat/);
});
