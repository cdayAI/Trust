'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomBytes}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const browserEnabled=process.env.RUN_BROWSER_SMOKE==='1';
const names={admin:'sample-admin',review:'sample-review',analysis:'sample-analysis',operator:'sample-operator',publisher:'sample-publisher'};
async function setup(t,{sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-directory-')),codes={};
  const isolated={root:join(root,'workspaces'),enableIdentityAdmin:true,directoryLifecycleWorkspaces:['north','south'],
    workspaces:['north','south'].map(id=>({id,label:'Sample '+id})),
    accounts:Object.entries({admin:'identity-admin',review:'reviewer',analysis:'analyst',operator:'case-operator',publisher:'publisher'}).map(([name,role])=>{
      codes[name]=randomBytes(32).toString('base64url');
      return {id:names[name],codeHash:codeHash(codes[name]),memberships:name==='publisher'?{south:role}:{north:role,south:role}};
    })};
  let url,server;
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  async function start(){
    server=createServer({isolated,sqliteFile:sqlite?join(root,'store.sqlite'):undefined}).listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});await start();
  async function api(route,expected,{token,workspace='north',body,origin=url}={}){
    const response=await fetch(url+'/api/'+route+(workspace===null?'':'?workspace='+workspace),{
      method:body===undefined?'GET':'POST',headers:{'X-Demo-Actor':'identity-admin',...(token?{Cookie:token}:{}),
        ...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin})},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await response.json();
    if(expected!==null)assert.equal(response.status,expected,route+' '+JSON.stringify(data));
    return {data,status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=(seat,workspace='north',expected=200)=>api('session/login',expected,
    {workspace:null,body:{account:names[seat],code:codes[seat],workspace}});
  const board=(token,expected=200,workspace='north')=>api('directory-lifecycle',expected,{token,workspace});
  const change=(token,operation,expectedRevision,fields,status=200,workspace='north')=>
    api('directory-lifecycle',status,{token,workspace,body:{operation,expectedRevision,...fields}});
  const draft=(token,expectedRevision,accounts,status=200,workspace='north')=>
    change(token,'draft',expectedRevision,{accounts,reason:'end-of-assignment'},status,workspace);
  const step=(token,operation,expectedRevision,plan,status=200,workspace='north')=>
    change(token,operation,expectedRevision,{plan:plan.id,digest:plan.digest},status,workspace);
  return {isolated,codes,api,login,board,draft,step,change,get url(){return url;},async restart(){await stop();await start();}};
}
const selected=[names.operator,names.analysis];
function digest(plan){
  const canonical=['mvw-directory-suspension-v1',plan.workspace,plan.id,plan.number,plan.reason,
    plan.preparedBy,plan.preparedAt,plan.expiresAt,plan.members.map(m=>[m.account,m.role,
      m.before.revision,m.before.disabled,m.after.revision,m.after.disabled])];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
test('independent approval applies an exact local plan atomically; other workspace remains independently eligible',async t=>{
  const f=await setup(t,{sqlite:true});
  const a=(await f.login('admin')).cookie,r=(await f.login('review')).cookie;
  const n=(await f.login('analysis')).cookie,o=(await f.login('operator')).cookie;
  const s=(await f.login('analysis','south')).cookie,sa=(await f.login('admin','south')).cookie,sr=(await f.login('review','south')).cookie;
  assert.ok((await f.api('session',200,{token:a,workspace:null})).data.capabilities.views.includes('directory-lifecycle'));
  await f.board(undefined,401);await f.board(n,403);await f.board(sa,403);
  await f.draft(r,0,selected,403);
  await f.draft(a,0,[names.publisher],422);
  await f.draft(a,0,[names.admin],422);
  await f.draft(a,0,[names.review],422);
  await f.draft(a,0,[names.analysis,names.analysis],422);
  await f.api('directory-lifecycle',403,{token:a,body:{},origin:'http://localhost:3'});
  assert.ok((await f.board(sa,200,'south')).data.candidates.some(x=>x.account===names.publisher));
  const plan=(await f.draft(a,0,selected)).data.plans[0];
  assert.equal(plan.digest,digest(plan));
  assert.deepEqual(plan.members.map(m=>m.account),selected.slice().sort());
  assert.doesNotMatch(JSON.stringify(plan),/preparedBinding|provisioning|codeHash|binding/);
  await f.step(a,'approve',1,plan,403);
  await f.step(sr,'approve',0,plan,404,'south');
  await f.step(a,'submit',1,plan);
  await f.step(r,'approve',2,{...plan,digest:'0'.repeat(64)},409);
  await f.api('state',200,{token:n});await f.api('state',200,{token:o});
  const concurrent=await Promise.all([f.step(r,'approve',2,plan,null),f.step(r,'approve',2,plan,null)]);
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);
  const approved=concurrent.find(x=>x.status===200).data.plans[0];
  assert.equal(approved.status,'approved');assert.equal(approved.decidedBy,names.review);
  assert.deepEqual(approved.members,plan.members);assert.equal(approved.digest,plan.digest);
  for(const token of [n,o])await f.api('state',401,{token});
  await f.login('analysis','north',401);await f.login('operator','north',401);
  await f.api('state',200,{token:s,workspace:'south'});
  await f.api('session/switch',403,{token:s,workspace:null,body:{current:'south',workspace:'north'}});
  const audit=(await f.api('audit/export',200,{token:r})).data.audit.filter(e=>e.action==='directory-lifecycle.member-suspended');
  assert.deepEqual(audit.map(e=>e.entityId),[names.analysis,names.operator]);
  assert.ok(audit.every(e=>e.account===names.review&&e.details.digest===plan.digest&&e.details.after.disabled));
  const southPlan=(await f.draft(sa,0,[names.analysis],200,'south')).data.plans[0];
  assert.notEqual(southPlan.digest,plan.digest);
  await f.step(sa,'submit',1,southPlan,200,'south');
  await f.step(sr,'approve',2,southPlan,200,'south');
  await f.api('state',401,{token:s,workspace:'south'});
  await f.restart();
  await f.login('analysis','north',401);await f.login('analysis','south',401);
  const next=(await f.login('review')).cookie;
  assert.equal((await f.board(next)).data.plans[0].digest,plan.digest);
  assert.equal((await f.api('state',200,{token:next})).data.directoryLifecycle,undefined);
});
test('stale captures cannot partially suspend; reprovisioned author cannot review own plan',async t=>{
  const f=await setup(t),a=(await f.login('admin')).cookie,r=(await f.login('review')).cookie;
  const p=(await f.draft(a,0,selected)).data.plans[0];
  await f.step(a,'submit',1,p);
  await f.api('identity-admin',200,{token:a,body:{target:names.operator,operation:'revoke',reason:'session-reset',expectedRevision:0}});
  assert.equal((await f.board(r)).data.plans[0].current,false);
  await f.step(r,'approve',2,p,409);
  await f.login('analysis');await f.login('operator');
  assert.deepEqual((await f.board(r)).data.audit.filter(e=>e.action==='member-suspended'),[]);
  await f.step(r,'reject',2,p);
  const next=(await f.draft(a,3,selected)).data.plans[0];
  await f.step(a,'submit',4,next);
  [f.isolated.accounts[0].memberships.north,f.isolated.accounts[1].memberships.north]=['reviewer','identity-admin'];
  await f.restart();
  const former=(await f.login('admin')).cookie;
  assert.equal((await f.step(former,'approve',5,next,403)).data.code,'DIRECTORY_INDEPENDENT_REVIEW');
  await f.login('analysis');await f.login('operator');
  assert.throws(()=>createServer({isolated:f.isolated,corporate:{}}),/limited to the local synthetic workbench/);
});
test('feature is off without opt-in, while applied suspensions remain enforced',async t=>{
  const f=await setup(t);
  const a=(await f.login('admin')).cookie,r=(await f.login('review')).cookie;
  const prepared=(await f.draft(a,0,[names.analysis])).data.plans[0];
  await f.step(a,'submit',1,prepared);await f.step(r,'approve',2,prepared);
  delete f.isolated.directoryLifecycleWorkspaces;await f.restart();
  const admin=(await f.login('admin')).cookie;
  await f.board(admin,404);
  await f.login('analysis','north',401);await f.login('analysis','south');
});
test('Chromium: separate local reviewer confirms the exact batch and an existing staff browser loses access',{
  skip:!browserEnabled&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:30000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function page(id){
      const p=await b.newPage();p.setDefaultTimeout(6000);await p.goto(f.url);
      await p.getByLabel('Test account').fill(names[id]);await p.getByLabel('Workspace ID').fill('north');
      await p.getByLabel('Local access code').fill(f.codes[id]);await p.getByRole('button',{name:'Sign in',exact:true}).click();
      return p;
    }
    const analyst=await page('analysis');
    await analyst.locator('#show-assessments').waitFor();
    const admin=await page('admin');
    await admin.getByRole('button',{name:'Directory reconciliation',exact:true}).click();
    await admin.getByLabel('sample-analysis · analyst').check();
    await admin.getByLabel('sample-operator · case-operator').check();
    await admin.getByLabel('Reconciliation reason').selectOption('directory-reconciliation');
    await admin.getByRole('button',{name:'Prepare suspension plan',exact:true}).click();
    await admin.getByRole('heading',{name:'Suspension plan 1',exact:true}).waitFor();
    async function decide(page,label){
      await page.locator('summary').filter({hasText:label}).click();
      const form=page.getByRole('form',{name:label,exact:true});
      await form.getByRole('checkbox').check();await form.getByRole('button',{name:label,exact:true}).click();
    }
    await decide(admin,'Submit plan for review');
    await admin.locator('#directory-lifecycle-view').getByText('review',{exact:true}).waitFor();
    const reviewer=await page('review');
    await reviewer.getByRole('button',{name:'Directory reconciliation',exact:true}).click();
    await reviewer.getByText('sample-analysis · analyst · Active generation 0 → Suspended generation 1',{exact:true}).waitFor();
    await decide(reviewer,'Approve and suspend accounts');
    await reviewer.getByText('All listed workspace memberships are suspended.',{exact:true}).waitFor();
    const status=await analyst.evaluate(async()=> (await fetch('/api/state?workspace=north')).status);
    assert.equal(status,401);
  }finally{await b.close();}
});
