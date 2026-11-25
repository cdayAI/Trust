'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const enabled=process.env.RUN_BROWSER_SMOKE==='1';
const fields=[{key:'sample-area',required:true},{key:'sample-count',required:false},{key:'sample-example',required:true}];
const answers={'sample-area':'sample-portal','sample-count':0,'sample-example':false};
async function setup(t,{sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-requester-form-'));
  const codes=Object.fromEntries(['analyst','reviewer','case-operator','legacy','first','second','south'].map(x=>[x,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'scopes'),
    workspaces:['north','south'].map(id=>({id,label:'Sample '+id})),
    accounts:['analyst','reviewer','case-operator'].map(role=>({id:'sample-'+role,memberships:{north:role,south:role},codeHash:codeHash(codes[role])})),
    requesterGrants:['legacy','first','second','south'].map(id=>({id,alias:'sample-'+id,workspace:id==='south'?'south':'north',
      codeHash:codeHash(codes[id]),expiresAt:Date.now()+3600000}))};
  let server,url;
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
  async function start(){server=createServer({isolated,sqliteFile:sqlite?join(root,'store.sqlite'):undefined}).listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});await start();
  async function api(route,expected,{token,space='north',body,headers={}}={}){
    const response=await fetch(url+'/api/'+route+(space===null?'':'?workspace='+space),{
      method:body===undefined?'GET':'POST',headers:{
        'X-Demo-Actor':'reviewer',...(token?{Cookie:token}:{}),
        ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...headers
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await response.json();
    assert.equal(response.status,expected,route+' '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  const login=async(role,workspace='north',id='sample-'+role,code=codes[role])=>(await api('session/login',200,
    {space:null,body:{account:id,workspace,code}})).cookie;
  const setting=(token,op,expectedRevision,extra={},status=200,space='north')=>api('rights/intake-form/'+op,status,
    {token,space,body:{expectedRevision,...extra}});
  const status=(id,expected=200)=>api('requester/status',expected,{space:null,body:{code:codes[id]}});
  const intake=(id,expected,extra={})=>api('requester/intake',expected,{space:null,body:{code:codes[id],kind:'access',...extra}});
  const rights=(token,space='north')=>api('rights/cases',200,{token,space});
  return {isolated,api,codes,login,setting,status,intake,rights,get url(){return url;},async restart(){await stop();await start();}};
}
async function publish(f,a,r,start=0,typed=fields){
  await f.setting(a,'save',start,{fields:typed});
  await f.setting(a,'submit',start+1);
  await f.setting(r,'publish',start+2);
}
test('requester form validates bounded fields, rejects stale publication, preserves exact receipts and prior pins',async t=>{
  const f=await setup(t,{sqlite:true});
  let a=await f.login('analyst'),r=await f.login('reviewer'),o=await f.login('case-operator');
  const legacy=(await f.intake('legacy',200)).data;
  assert.ok(legacy.receipt);assert.equal(legacy.intakeFormVersion,undefined);
  await f.status('reviewer',401);
  await f.setting(o,'save',0,{fields},403);
  await f.setting(a,'publish',0,{},403);
  await f.setting(r,'save',0,{fields},403);
  await f.setting(a,'save',0,{fields:[{key:'email',required:true}]},422);
  await f.setting(a,'save',0,{fields:[fields[0],fields[0]]},422);
  await f.setting(a,'save',0,{fields});
  assert.equal((await f.status('first')).data.form,undefined);
  await f.setting(a,'submit',1);
  await f.setting(r,'publish',1,{},409);
  await f.setting(r,'return',2,{reason:'too-many-fields'});
  assert.equal((await f.status('first')).data.form,undefined);
  await f.setting(a,'submit',3);
  await f.setting(r,'publish',4);
  const first=(await f.status('first')).data.form;
  assert.equal(first.version,1);
  assert.deepEqual(first.fields.map(x=>x.type),['choice','integer','boolean']);
  assert.equal((await f.status('south')).data.form,undefined);
  await f.intake('first',409);
  await f.intake('first',422,{formVersion:1,answers:{...answers,'email':'invalid'}});
  await f.intake('first',422,{formVersion:1,answers:{...answers,'sample-count':100}});
  await f.intake('first',422,{formVersion:1,answers:{...answers,'sample-count':'0'}});
  await f.intake('first',422,{formVersion:1,answers:{...answers,'sample-example':'false'}});
  await f.intake('first',422,{formVersion:1,answers:{'sample-example':false}});
  await f.intake('first',422,{formVersion:1,answers:{...answers,'sample-area':'other'}});
  const submission=(await f.intake('first',200,{formVersion:1,answers})).data;
  assert.equal(submission.intakeFormVersion,1);
  assert.doesNotMatch(JSON.stringify(submission),/sample-area|sample-portal|contributors|draft|form\W*:/);
  assert.equal((await f.rights(a)).data.cases.at(-1).requesterIntake.answers['sample-count'],0);
  assert.equal((await f.rights(o)).data.intakeSettings,undefined);
  await publish(f,a,r,5,[{key:'sample-count',required:true}]);
  const stale=(await f.intake('second',409,{formVersion:1,answers})).data;
  assert.equal(stale.code,'STALE_INTAKE_FORM');
  const current=(await f.status('second')).data.form;
  assert.equal(current.version,2);assert.deepEqual(current.fields.map(x=>x.key),['sample-count']);
  const second=(await f.intake('second',200,{formVersion:2,answers:{'sample-count':7}})).data;
  assert.equal(second.intakeFormVersion,2);
  assert.equal((await f.intake('first',200,{formVersion:1,answers})).data.receipt,submission.receipt);
  await f.intake('first',409,{formVersion:1,answers:{...answers,'sample-count':4}});
  await f.intake('first',409,{formVersion:2,answers:{'sample-count':1}});
  assert.equal((await f.intake('legacy',200)).data.receipt,legacy.receipt);
  await f.restart();a=await f.login('analyst');r=await f.login('reviewer');o=await f.login('case-operator');
  assert.equal((await f.status('first')).data.intakeFormVersion,1);
  assert.equal((await f.status('second')).data.intakeFormVersion,2);
  const staff=(await f.rights(a)).data;
  assert.deepEqual(staff.cases.map(x=>x.requesterIntake?.version),[undefined,1,2]);
  assert.deepEqual(staff.cases[1].requesterIntake.answers,answers);
  assert.deepEqual(staff.intakeSettings.history.map(x=>x.number),[1,2]);
  const caseId=staff.cases[1].id;
  await f.api('rights/cases/'+caseId+'/assign',200,{token:a,body:{expectedRevision:staff.cases[1].revision,
    owner:'case-operator',note:'Assignment for synthetic scope verification.'}});
  const operatorCase=(await f.rights(o)).data.cases.find(x=>x.id===caseId);
  assert.ok(operatorCase);assert.equal(operatorCase.requesterIntake,undefined);
  assert.doesNotMatch(JSON.stringify((await f.api('state',200,{token:a})).data),/requesterIntake|sample-portal/);
  const audit=(await f.api('audit/export',200,{token:r})).data.audit.filter(x=>x.action.startsWith('requester-intake-form.'));
  assert.deepEqual(audit.filter(x=>x.action.endsWith('.publish')).map(x=>[x.account,x.details.formVersion]),[['sample-reviewer',1],['sample-reviewer',2]]);
  assert.doesNotMatch(JSON.stringify(audit),/sample-count|sample-portal|answers|codeHash/);
});
test('a draft contributor who is re-provisioned as reviewer cannot publish their own form',async t=>{
  const f=await setup(t),a=await f.login('analyst');
  await f.setting(a,'save',0,{fields});await f.setting(a,'submit',1);
  [f.isolated.accounts[0].memberships.north,f.isolated.accounts[1].memberships.north]=['reviewer','analyst'];
  await f.restart();
  const former=await f.login('analyst');
  const denied=(await f.setting(former,'publish',2,{},403)).data;
  assert.equal(denied.code,'INDEPENDENT_INTAKE_FORM_REVIEW_REQUIRED');
  assert.deepEqual((await f.rights(former)).data.intakeSettings.allowed,[]);
  assert.equal((await f.status('first')).data.form,undefined);
});
test('Chromium: staff publishes a bounded form, stale requester reloads, and typed answers pin without public echo',{
  skip:!enabled&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:30000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function staff(role){
      const p=await browser.newPage();p.setDefaultTimeout(6500);await p.goto(f.url);
      await p.getByLabel('Test account').fill('sample-'+role);await p.getByLabel('Workspace ID').fill('north');
      await p.getByLabel('Local access code').fill(f.codes[role]);await p.getByRole('button',{name:'Sign in',exact:true}).click();
      await p.locator('#show-rights').click();await p.getByRole('heading',{name:'Requester intake form',exact:true}).waitFor();
      return p;
    }
    const author=await staff('analyst');
    await author.getByLabel('Include Fictional record count').check();
    await author.getByLabel('Require Fictional record count').check();
    await author.getByRole('button',{name:'Save intake form draft'}).click();
    await author.getByRole('button',{name:'Submit intake form for review'}).click();
    const reviewer=await staff('reviewer');
    await reviewer.getByLabel('Confirm publishing this exact fictional form.').check();
    await reviewer.getByRole('button',{name:'Publish intake form'}).click();
    await reviewer.getByText('Current published form: version 1',{exact:true}).waitFor();
    const requester=await browser.newPage();requester.setDefaultTimeout(6500);
    await requester.goto(f.url+'/requester');await requester.getByLabel('Synthetic access code').fill(f.codes.first);
    await requester.getByRole('button',{name:'Check my request'}).click();
    await requester.getByLabel('Fictional record count').fill('0');
    await publish(f,await f.login('analyst'),await f.login('reviewer'),3,[{key:'sample-example',required:true}]);
    await requester.getByRole('button',{name:'Submit synthetic request'}).click();
    await requester.getByRole('button',{name:'Load current request form'}).click();
    await requester.getByText('Current fictional form version: 2',{exact:true}).waitFor();
    await requester.getByLabel('Include a fictional example').selectOption('false');
    await requester.getByRole('button',{name:'Submit synthetic request'}).click();
    await requester.getByText('Pinned fictional form version: 2',{exact:true}).waitFor();
    assert.match(await requester.locator('#portal-result').innerText(),/Receipt:/);
    assert.doesNotMatch(await requester.locator('#portal-result').innerText(),/fictional example|false/);
    await author.locator('#show-rights').click();
    await author.locator('summary').filter({hasText:'Requester form version 2'}).click();
    await author.locator('#rights-view article dt').filter({hasText:'Include a fictional example'}).waitFor();
  }finally{await browser.close();}
});
