'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const newCode=()=>randomBytes(32).toString('base64url');
function fixture(root,now){
  const rows={
    'intake-a':{code:newCode(),memberships:{alpha:'analyst',beta:'reviewer'}},
    'review-a':{code:newCode(),memberships:{alpha:'reviewer'}},
    'intake-b':{code:newCode(),memberships:{beta:'analyst'}},
    'publish-a':{code:newCode(),memberships:{alpha:'publisher'}},
  };
  return {rows,options:{root,now,sessionSeconds:90,
    workspaces:[{id:'alpha',label:'Synthetic Alpha'},{id:'beta',label:'Synthetic Beta'}],
    accounts:Object.entries(rows).map(([id,{code,memberships}])=>({id,codeHash:codeHash(code),memberships}))
  }};
}
async function serve(t,options){
  const server=createServer({isolated:options});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {server,url};
}
test('isolated HTTP keeps workflow records and audit in separate workspaces and derives approval identity',async t=>{
  let now=Date.now();
  const root=await mkdtemp(join(tmpdir(),'trust-access-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const {rows,options}=fixture(root,()=>now);
  let {url}=await serve(t,options);
  async function req(path,status,{token,body,headers={}}={}){
    const r=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:url}),...(token?{Cookie:token}:{}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await r.json();
    assert.equal(r.status,status,JSON.stringify(data));
    return {data,cookie:r.headers.get('set-cookie')};
  }
  const auth=async(account,workspace)=>{
    const {cookie,data}=await req('session/login',200,{body:{account,workspace,code:rows[account].code}});
    assert.match(cookie,/; HttpOnly; SameSite=Strict$/);
    assert.match(cookie,/; Max-Age=90;/);
    assert.doesNotMatch(JSON.stringify(data),new RegExp(rows[account].code));
    return {token:cookie.split(';')[0],data};
  };
  const location=(route,workspace='alpha')=>route+'?workspace='+workspace;
  const plan={name:'Fictional isolated alpha intake'};
  assert.deepEqual((await req('session',200)).data,{mode:'local-isolated',authenticated:false});
  for(const route of ['state','audit/export','governance-documents','work-queue/export','workflows/audit','rights/cases','incidents/cases','data-map/export','risk-controls/export']){
    await req(location(route),401,{headers:{'X-Demo-Actor':'analyst'}});
  }
  await req(location('projects'),401,{body:plan,headers:{'X-Demo-Actor':'analyst'}});
  await req('session/login',401,{body:{account:'review-a',workspace:'beta',code:rows['review-a'].code}});
  await req('session/login',401,{body:{account:'intake-a',workspace:'alpha',code:newCode()}});
  await req('session/login',403,{body:{},headers:{Origin:'http://localhost:1'}});
  assert.deepEqual(await readdir(join(root,'alpha')),[]);
  assert.deepEqual(await readdir(join(root,'beta')),[]);
  const {token:a}=await auth('intake-a','alpha');
  const {token:r,data:reviewSession}=await auth('review-a','alpha');
  assert.deepEqual(reviewSession.workspaces.map(w=>w.id),['alpha']);
  await req('state',403,{token:r});
  await req('state?workspace=alpha&workspace=beta',403,{token:a});
  await req(location('state','beta'),403,{token:r});
  await req(location('projects','beta'),403,{token:r,body:plan});
  await req('session/switch',403,{token:r,body:{current:'alpha',workspace:'beta'}});
  await req(location('projects'),403,{token:r,body:plan,headers:{'X-Demo-Actor':'analyst'}});
  await req(location('projects'),403,{token:a,body:plan,headers:{Origin:''}});
  assert.deepEqual(await readdir(join(root,'beta')),[]);
  const project=(await req(location('projects'),200,{token:a,body:plan})).data.projects[0];
  const record=(await req(location('vendors'),200,{token:a,body:{projectId:project.id,name:'Fictional isolated vendor',usesAI:false}})).data.assessments[0];
  const route=action=>location('assessments/'+record.id+'/'+action);
  const submitted=(await req(route('submit'),200,{token:a,body:{answers:{summary:'Synthetic intake scope',safeguards:'Synthetic review',externalSharing:'No'},expectedRevision:record.revision}})).data.assessments[0];
  const decision={reason:'Verified synthetic controls.',expectedRevision:submitted.revision};
  await req(route('approve'),403,{token:a,body:decision,headers:{'X-Demo-Actor':'reviewer'}});
  assert.equal((await req(route('approve'),200,{token:r,body:decision})).data.assessments[0].status,'approved');
  const audit=(await req(location('audit/export'),200,{token:r})).data;
  assert.equal(audit.mode,'local-isolated');
  assert.equal(audit.audit.find(e=>e.action==='assessment.submitted').account,'intake-a');
  assert.equal(audit.audit.find(e=>e.action==='assessment.approved').account,'review-a');
  assert.equal(audit.audit.find(e=>e.action==='assessment.refused').account,'intake-a');
  assert.ok(Array.isArray((await req(location('work-queue/export')+'&owner=analyst',200,{token:a})).data.tasks));
  const {token:p}=await auth('publish-a','alpha');
  const definition={
    id:'synthetic-a',initial:'new',states:[{id:'new',label:'New'},{id:'done',label:'Done'}],
    transitions:[{id:'finish',from:'new',to:'done',roles:['initiator']}],
  };
  await req(location('workflows/definitions'),200,{token:p,body:{definition,expectedVersion:0}});
  const {cookie,data}=await req('session/switch',200,{token:a,body:{current:'alpha',workspace:'beta'}});
  const b=cookie.split(';')[0];
  assert.notEqual(b,a);
  assert.equal(data.actor,'reviewer');
  await req(location('state'),401,{token:a});
  await req(location('audit/export'),403,{token:b});
  assert.deepEqual((await req(location('state','beta'),200,{token:b})).data.projects,[]);
  assert.deepEqual((await req(location('audit/export','beta'),200,{token:b})).data.audit,[]);
  await req(location('workflows/definitions/synthetic-a','beta'),404,{token:b});
  const {token:bWriter}=await auth('intake-b','beta');
  await req(location('vendors','beta'),404,{token:bWriter,body:{projectId:project.id,name:'Synthetic unrelated vendor'}});
  await req(location('projects','beta'),200,{token:bWriter,body:{name:'Fictional isolated beta intake'}});
  assert.deepEqual((await req(location('state'),200,{token:r})).data.projects.map(x=>x.name),[plan.name]);
  await req('session/logout',200,{token:b,body:{}});
  await req(location('state','beta'),401,{token:b});
  now+=90_000;
  await req(location('state'),401,{token:r});
  const restarted=await serve(t,options);
  url=restarted.url;
  await req(location('state','beta'),401,{token:bWriter});
  const {token:again}=await auth('review-a','alpha');
  assert.deepEqual((await req(location('audit/export'),200,{token:again})).data.audit,audit.audit);
  const {token:fresh}=await auth('intake-b','beta');
  assert.deepEqual((await req(location('state','beta'),200,{token:fresh})).data.projects.map(x=>x.name),['Fictional isolated beta intake']);
});
test('an explicit invalid isolation configuration never opens an unrestricted demo',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-invalid-config-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const {options}=fixture(root,Date.now);
  assert.throws(()=>createServer({isolated:null}));
  assert.throws(()=>createServer({isolated:{...options,accounts:[]}}),/Invalid isolated/);
  assert.throws(()=>createServer({isolated:{...options,accounts:[
    ...options.accounts,{id:'second-analyst',codeHash:codeHash(newCode()),memberships:{alpha:'analyst'}}
  ]}}),/duplicated workspace role/);
  assert.throws(()=>createServer({isolated:{...options,workspaces:[{id:'../outside',label:'Invalid'}]}}),/Invalid isolated workspace/);
});
