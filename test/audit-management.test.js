'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const prefix='audit-management';
test('local audit scopes controls, assesses synthetic evidence and freezes an independently reviewed report',async t=>{
  const root=await mkdtemp(join(tmpdir(),'synthetic-audit-'));
  const ids=['audit-intake','audit-reviewer','other-workspace'];
  const passwords=Object.fromEntries(ids.map(id=>[id,randomBytes(32).toString('base64url')]));
  const options={root,workspaces:[{id:'alpha',label:'Synthetic A'},{id:'beta',label:'Synthetic B'}],
    accounts:ids.map((id,i)=>({id,codeHash:codeHash(passwords[id]),memberships:{[i===2?'beta':'alpha']:i===1?'reviewer':'analyst'}}))};
  let server,url;
  async function start(){
    server=createServer({isolated:options});
    server.listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server?.listening)await new Promise(r=>server.close(r))}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function raw(route,{cookie,body,headers={}}={}){
    const response=await fetch(url+'/api/'+route,{method:body===undefined?'GET':'POST',
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {response,data:await response.json()};
  }
  async function request(route,status,opts){
    const result=await raw(route,opts);
    assert.equal(result.response.status,status,JSON.stringify(result.data));return result;
  }
  async function login(account,workspace='alpha'){
    const {response}=await request('session/login',200,{body:{account,workspace,code:passwords[account]}});
    return response.headers.get('set-cookie').split(';')[0];
  }
  let a=await login(ids[0]),r=await login(ids[1]);
  const b=await login(ids[2],'beta');
  const get=(route,status=200,cookie=r,workspace='alpha')=>request(route+'?workspace='+workspace,status,{cookie});
  const write=(route,body,status=200,cookie=a)=>request(route+'?workspace=alpha',status,{cookie,body});
  await request(prefix+'?workspace=alpha',401);
  const control=async(rev,title)=>(await write('risk-controls/controls',{title,intent:'Synthetic control objective',expectedRevision:rev})).data.controls.at(-1);
  const c1=await control(0,'Synthetic access review');
  const c2=await control(1,'Synthetic retention check');
  const outside=await control(2,'Outside scope');
  const create={title:'Synthetic first-quarter audit',scope:'Q1 fictional environment',objective:'Check two local controls',controlIds:[c1.id,c2.id]};
  await write(prefix+'/plans',{...create,controlIds:[c1.id,c1.id]},422);
  await write(prefix+'/plans',create,403,r);
  let plan=(await write(prefix+'/plans',create)).data.plans[0];
  assert.equal(plan.createdBy,ids[0]);
  assert.deepEqual(plan.controls.map(x=>x.id),[c1.id,c2.id]);
  assert.deepEqual((await get(prefix,200,b,'beta')).data.plans,[]);
  const route=prefix+'/plans/'+plan.id;
  const action=async(op,payload={},status=200,cookie=a)=>{
    const result=await write(route+'/'+op,{expectedRevision:plan.revision,...payload},status,cookie);
    if(status===200)plan=result.data.plans[0];
    return result.data;
  };
  await get(route+'/report',409);
  await action('begin');
  await action('submit',{},422);
  const evidence={controlId:c1.id,evidenceReference:'SYN-ACCESS-01',outcome:'effective',observation:'Synthetic review completed'};
  await action('assess',{...evidence,controlId:outside.id},422);
  await action('assess',{...evidence,evidenceReference:'https://example.invalid/file'},422);
  await action('assess',evidence);
  const first=plan.assessments[0].id;
  await action('assess',{...evidence,controlId:c2.id,outcome:'exception'},422);
  await action('assess',{...evidence,controlId:c2.id,evidenceReference:'SYN-RETENTION-01',outcome:'exception',severity:'high',correctiveAction:'Add synthetic check'});
  await action('submit');
  const snapshot=structuredClone(plan);
  await action('finalize',{note:'Self-review fails'},403);
  await request(route+'/finalize?workspace=alpha',403,{cookie:a,body:{note:'Header role cannot override local session',expectedRevision:plan.revision},headers:{'X-Demo-Actor':'reviewer'}});
  assert.deepEqual((await get(prefix)).data.plans[0],snapshot);
  await action('return',{note:'Clarify sample count'},200,r);
  await action('assess',{...evidence,evidenceReference:'SYN-ACCESS-02',observation:'Checked two synthetic accounts'});
  assert.equal(plan.assessments.at(-1).supersedes,first);
  await action('submit');
  await action('finalize',{expectedRevision:plan.revision-1,note:'Stale review did not finalize'},409,r);
  await action('finalize',{note:'Verified synthetic findings'},200,r);
  assert.equal(plan.status,'finalized');
  assert.equal(plan.reviews.at(-1).reviewer,ids[1]);
  const download=await get(route+'/report');
  assert.match(download.response.headers.get('content-disposition'),/^attachment/);
  assert.equal(download.data.result.conclusion,'exceptions-found');
  assert.deepEqual(download.data.result.counts,{effective:1,exception:1,inconclusive:0});
  assert.equal(download.data.result.controls[1].assessment.finding.severity,'high');
  assert.equal(download.data.result.assessmentHistory.length,3);
  assert.equal(download.data.sha256,createHash('sha256').update(JSON.stringify(download.data.result)).digest('hex'));
  await action('assess',evidence,409);
  await action('finalize',{note:'Replay'},409,r);
  await get(route+'/report',404,b,'beta');
  const audit=(await get('audit/export')).data.audit;
  assert.equal(audit.find(e=>e.action===prefix+'.finalize').account,ids[1]);
  assert.equal(audit.find(e=>e.action===prefix+'.finalize').details.sha256,download.data.sha256);
  await stop(); await start(); r=await login(ids[1]);
  assert.deepEqual((await get(route+'/report')).data,download.data);
});
