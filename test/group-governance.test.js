'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const browserEnabled=process.env.RUN_BROWSER_SMOKE==='1';
const exampleSummary='Exact approved fictional case lookup summary.';
async function setup(t,{enabled=true,sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-governance-')),codes=new Map(),startAt=Date.now();
  let now=startAt,server,url;
  function account(id,role,spaces=['north','south']){
    const secret=randomBytes(32).toString('base64url');codes.set(id,secret);
    return {id,codeHash:codeHash(secret),memberships:Object.fromEntries(spaces.map(s=>[s,role]))};
  }
  const workspaces=[{id:'north',label:'Sample North'},{id:'south',label:'Sample South'}];
  const config={enableIdentityAdmin:true,root:join(root,'workspaces'),workspaces,now:()=>now,accounts:[
    account('sample-admin','identity-admin'),account('sample-review','reviewer'),
    account('sample-analyst','analyst'),account('sample-case','case-operator'),
    account('sample-publisher','publisher'),account('sample-south-only','ethics-investigator',['south'])
  ]};
  const northCatalog={workspace:'north',applications:[
    {id:'sample-case-reference',name:'Fictional Case Reference',summary:exampleSummary},
    {id:'sample-private-app',name:'Unapproved summary never shown',summary:'Sample withdrawn data.'}
  ]};
  if(enabled)config.groupApplications=[northCatalog];
  const options={isolated:config,sqliteFile:sqlite?join(root,'groups.sqlite'):undefined};
  async function stop(){
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  async function start(){
    server=createServer(options).listen(0,'127.0.0.1');await once(server,'listening');
    url='http://127.0.0.1:'+server.address().port;
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function call(route,expected,{token,workspace='north',body,method=body===undefined?'GET':'POST',origin=url}={}){
    const suffix=workspace===null?'':'?workspace='+encodeURIComponent(workspace);
    const response=await fetch(url+'/api/'+route+suffix,{method,headers:{
      'X-Demo-Actor':'identity-admin',...(token?{Cookie:token}:{}),
      ...(body!==undefined?{Origin:origin,'Content-Type':'application/json'}:{})
    },body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    if(expected!==null)assert.equal(response.status,expected,method+' /api/'+route+' '+JSON.stringify(data));
    return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(id,workspace='north',expected=200)=>{
    const reply=await call('session/login',expected,{workspace:null,body:{account:id,code:codes.get(id),workspace}});
    return {token:reply.cookie,capabilities:reply.data.capabilities};
  };
  const mutation=(token,operation,expectedRevision,details={},status=200,workspace='north')=>
    call('group-governance',status,{token,workspace,body:{operation,group:'sample-privacy-ops',expectedRevision,...details}});
  const board=(token,n=200,workspace='north')=>call('group-governance',n,{token,workspace});
  const scoped=(token,n=200,workspace='north')=>call('scoped-applications',n,{token,workspace});
  return {root,config,codes,call,login,mutation,board,scoped,northCatalog,get url(){return url;},
    elapse(ms){now=startAt+ms;},async restart(){await stop();await start();}};
}
const member={kind:'member',target:'sample-case'};
const app={kind:'app',target:'sample-case-reference'};

async function seedApprovals(f,admin,reviewer){
  await f.mutation(admin,'create-group',0);
  await f.mutation(admin,'propose-member',1,{target:member.target});
  await f.mutation(admin,'propose-app',2,{target:app.target});
  await f.mutation(reviewer,'approve',3,member);
  await f.mutation(reviewer,'approve',4,app);
}

test('approves two exact relationships independently, filters app summaries, and revokes without granting other permissions',async t=>{
  const f=await setup(t);
  const {token:admin,capabilities}=await f.login('sample-admin'),{token:reviewer}=await f.login('sample-review');
  const {token:analyst}=await f.login('sample-analyst'),{token:operator,capabilities:caseViews}=await f.login('sample-case');
  const {token:publisher}=await f.login('sample-publisher'),{token:other,capabilities:otherViews}=await f.login('sample-case','south');
  const {token:otherAdmin}=await f.login('sample-admin','south');
  assert.deepEqual(capabilities.views,['identity-admin','group-governance']);
  assert.ok(caseViews.views.includes('scoped-applications')&&!otherViews.views.includes('scoped-applications'));
  await f.board(undefined,401);
  for(const token of [operator,analyst,publisher])await f.board(token,403);
  for(const token of [admin,reviewer,publisher])await f.scoped(token,403);
  await f.scoped(other,403);await f.scoped(other,404,'south');await f.board(otherAdmin,404,'south');
  await f.mutation(admin,'create-group',0,{},403,'south');
  await f.call('group-governance',404,{token:admin,method:'DELETE'});
  await f.call('group-governance',403,{token:admin,body:{},origin:'http://localhost:5'});
  await f.call('group-governance?search=one&ignored=',403,{token:admin,workspace:null});
  await f.call('group-governance',422,{token:admin,body:{group:'sample-x',operation:'create-group',expectedRevision:0,role:'reviewer'}});
  assert.deepEqual((await f.scoped(operator)).data,{applications:[]});
  await f.mutation(reviewer,'create-group',0,{},403);
  await f.mutation(admin,'create-group',0);
  await f.mutation(admin,'create-group',0,{},409);
  await f.mutation(admin,'propose-member',1,{target:'sample-south-only'},422);
  await f.mutation(admin,'propose-member',1,{target:'sample-admin'},422);
  await f.mutation(admin,'propose-app',1,{target:'anything'},422);
  await f.mutation(admin,'propose-member',1,{target:member.target});
  await f.mutation(admin,'propose-app',2,{target:app.target});
  const review=(await f.board(reviewer)).data;
  assert.equal(review.relationships.find(x=>x.kind==='app').application.summary,exampleSummary);
  assert.equal(review.catalog,undefined);
  assert.doesNotMatch(JSON.stringify((await f.board(admin)).data),/fingerprint|provisioning|codeHash|sample-south-only/);
  await f.mutation(admin,'approve',3,member,403);
  await f.mutation(reviewer,'approve',3,member);
  assert.deepEqual((await f.scoped(operator)).data,{applications:[]});
  const decisions=await Promise.all([f.mutation(reviewer,'approve',4,app,null),f.mutation(reviewer,'approve',4,app,null)]);
  assert.deepEqual(decisions.map(x=>x.status).sort(),[200,409]);
  assert.deepEqual((await f.scoped(operator)).data,{applications:[f.northCatalog.applications[0]]});
  assert.deepEqual((await f.scoped(analyst)).data,{applications:[]});
  await f.call('reporting',403,{token:operator});
  await f.call('rights/cases',200,{token:operator});
  await f.call('modules',403,{token:admin});
  await f.call('scoped-applications',404,{token:operator,body:{}});
  await f.call('scoped-applications/any',404,{token:operator});
  await f.mutation(admin,'revoke',5,app);
  assert.deepEqual((await f.scoped(operator)).data,{applications:[]});
  await f.mutation(admin,'propose-app',6,{target:app.target});
  await f.mutation(reviewer,'reject',7,app);
  await f.mutation(reviewer,'approve',8,app,409);
  await f.mutation(admin,'propose-app',8,{target:app.target});
  await f.mutation(reviewer,'approve',9,app);
  await f.mutation(admin,'archive-group',10);
  assert.deepEqual((await f.scoped(operator)).data,{applications:[]});
  assert.deepEqual((await f.board(admin)).data.audit.map(e=>e.revision),[11,10,9,8,7,6,5,4,3,2,1]);
  assert.equal((await f.call('state',200,{token:reviewer})).data.groupGovernance,undefined);
  assert.deepEqual((await f.call('audit/export',200,{token:reviewer})).data.audit.filter(e=>e.action.startsWith('group-governance.')).map(e=>e.actor),
    ['identity-admin','identity-admin','identity-admin','reviewer','reviewer','identity-admin','identity-admin','reviewer','identity-admin','reviewer','identity-admin']);
});

for(const sqlite of [false,true])test(`group grants persist through ${sqlite?'SQLite':'JSON'} restart and invalidate on seat generation or changed app scope`,async t=>{
  const f=await setup(t,{sqlite});
  const {token:admin}=await f.login('sample-admin'),{token:reviewer}=await f.login('sample-review'),{token:operator}=await f.login('sample-case');
  await seedApprovals(f,admin,reviewer);
  assert.equal((await f.scoped(operator)).data.applications.length,1);
  await f.restart();
  await f.scoped(operator,401);
  const a=(await f.login('sample-admin')).token, r=(await f.login('sample-review')).token,o=(await f.login('sample-case')).token;
  assert.equal((await f.scoped(o)).data.applications.length,1);
  await f.call('identity-admin',200,{token:a,body:{target:'sample-case',operation:'revoke',reason:'session-reset',expectedRevision:0}});
  await f.scoped(o,401);
  const replacement=(await f.login('sample-case')).token;
  assert.equal((await f.scoped(replacement)).data.applications.length,0);
  assert.equal((await f.board(a)).data.relationships.find(x=>x.kind==='member').status,'stale');
  await f.mutation(a,'propose-member',5,{target:member.target});
  await f.mutation(r,'approve',6,member);
  assert.equal((await f.scoped(replacement)).data.applications.length,1);
  f.northCatalog.applications[0].summary='Different scope requires explicit approval.';
  await f.restart();
  const newSession=(await f.login('sample-case')).token,newAdmin=(await f.login('sample-admin')).token;
  assert.equal((await f.scoped(newSession)).data.applications.length,0);
  assert.equal((await f.board(newAdmin)).data.relationships.find(x=>x.kind==='app').status,'stale');
  f.elapse(30*24*60*60*1000+1);
  assert.equal((await f.board((await f.login('sample-admin')).token)).data.relationships.find(x=>x.kind==='member').status,'expired');
});

test('group application provisioning is fail-closed and opt-in',async t=>{
  const f=await setup(t,{enabled:false});
  const {token:admin,capabilities}=await f.login('sample-admin');
  assert.deepEqual(capabilities.views,['identity-admin']);
  await f.board(admin,404);
  assert.throws(()=>createServer({isolated:{...f.config,groupApplications:[f.northCatalog],enableIdentityAdmin:false}}),
    /requires isolated identity administration/);
  assert.throws(()=>createServer({isolated:{...f.config,groupApplications:[f.northCatalog],
    accounts:f.config.accounts.filter(x=>x.id!=='sample-review')}}),/distinct provisioned/);
  assert.throws(()=>createServer({isolated:{...f.config,groupApplications:[{...f.northCatalog,
    applications:[{...f.northCatalog.applications[0],url:'https://example.invalid'}]}]}}),/Invalid synthetic app summary/);
});

test('browser: admin proposes, separate reviewer approves and operator sees only the approved app summary',{
  skip:!browserEnabled&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000
},async t=>{
  const {chromium}=require('playwright');
  const f=await setup(t);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function signIn(id){
      const page=await browser.newPage();page.setDefaultTimeout(5500);await page.goto(f.url);
      await page.getByLabel('Test account').fill(id);await page.getByLabel('Workspace ID').fill('north');
      await page.getByLabel('Local access code').fill(f.codes.get(id));
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      return page;
    }
    const manager=await signIn('sample-admin');
    await manager.getByRole('button',{name:'Group governance',exact:true}).click();
    await manager.getByLabel('New synthetic group ID').fill('sample-privacy-ops');
    await manager.getByRole('button',{name:'Create group',exact:true}).click();
    await manager.getByRole('heading',{name:'sample-privacy-ops',exact:true}).waitFor();
    for(const [name,selection,value] of [['Propose membership','Eligible workspace account','sample-case'],
      ['Propose app grant','Provisioned application','sample-case-reference']]){
      await manager.locator('summary').getByText(name,{exact:true}).click();
      await manager.getByLabel(selection).selectOption(value);
      await manager.getByRole('button',{name,exact:true}).click();
    }
    await manager.getByRole('heading',{name:'Application: sample-case-reference'}).waitFor();
    const reviewer=await signIn('sample-review');
    await reviewer.getByRole('button',{name:'Group governance',exact:true}).click();
    await reviewer.getByText('Fictional Case Reference: '+exampleSummary,{exact:true}).waitFor();
    for(const label of ['Approve membership for sample-case','Approve app grant for sample-case-reference']){
      await reviewer.locator('summary').getByText(label,{exact:true}).click();
      const form=reviewer.getByRole('form',{name:label,exact:true});
      await form.getByRole('checkbox').check();await form.getByRole('button',{name:'Approve',exact:true}).click();
      await form.waitFor({state:'detached'});
    }
    const operator=await signIn('sample-case');
    await operator.getByRole('button',{name:'Scoped applications',exact:true}).click();
    await operator.getByRole('heading',{name:'Fictional Case Reference',exact:true}).waitFor();
    assert.equal(await operator.getByText('Unapproved summary never shown',{exact:true}).count(),0);
    assert.equal(await operator.getByRole('button',{name:'Group governance',exact:true}).count(),0);
  }finally{await browser.close();}
});
