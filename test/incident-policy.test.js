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
const policy=require('../incident-policy');
const workflow=require('../incident-workflow');
const seats=[
  ['alpha-incident-author','alpha','analyst'],['alpha-incident-reviewer','alpha','reviewer'],
  ['alpha-incidents-scope','alpha','case-operator'],['beta-incident-author','beta','analyst']
];
const api='/api/incidents/',fake='Fictional tabletop scenario only.';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'mvw-incident-policy-'));
  const codes=Object.fromEntries(seats.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(dir,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:seats.map(([id,ws,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[ws]:role}}))};
  let server,url;
  async function start(){
    server=createServer({isolated,sqliteFile:join(dir,'incident-test.sqlite')}).listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  await start();
  async function request(path,status,{cookie,workspace='alpha',body,spoof}={}){
    const endpoint=new URL(path,url);
    if(!path.startsWith('/api/session'))endpoint.searchParams.set('workspace',workspace);
    const response=await fetch(endpoint,{method:body===undefined?'GET':'POST',
      headers:{...(cookie?{Cookie:cookie}:{}),...(spoof?{'X-Demo-Actor':spoof}:{}),
        ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    assert.equal(response.status,status,path+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login([account,workspace]){
    const {cookie}=await request('/api/session/login',200,{body:{account,workspace,code:codes[account]}});
    return cookie;
  }
  return {start,stop,request,login,get url(){return url;},codes};
}
const hours=(timestamp,added)=>new Date(Date.parse(timestamp)+added*3_600_000).toISOString();

test('isolated SQLite: approve matrix versions, preserve fallback and pinned routes, schedule review and mock notice work',async t=>{
  const f=await fixture(t);
  let [analyst,reviewer,limited,beta]=await Promise.all(seats.map(f.login));
  const get=async()=> (await f.request(api+'cases',200,{cookie:analyst})).data;
  let model=await get();
  assert.equal(model.policy.activeVersion,null);
  await f.request(api+'cases',401);
  await f.request(api+'cases',403,{cookie:limited,spoof:'analyst'});
  await f.request(api+'cases',403,{cookie:beta});
  async function command(action,payload={},status=200,cookie=analyst,extra={}){
    const {data}=await f.request(api+'policy/'+action,status,{cookie,body:{expectedRevision:model.policy.revision,...payload},...extra});
    if(status===200)model=data;
    return data;
  }
  async function open(title,scopeClass,status=200){
    const {data}=await f.request(api+'cases',status,{cookie:analyst,body:{title,scope:fake,...(scopeClass===undefined?{}:{scopeClass})}});
    if(status===200){model=data;return model.cases.at(-1);}
    return data;
  }
  async function advance(id,action,payload={},status=200,cookie=analyst){
    const prior=model.cases.find(row=>row.id===id);
    const {data}=await f.request(api+'cases/'+id+'/'+action,status,{cookie,body:{expectedRevision:prior.revision,...payload}});
    if(status===200){model=data;return model.cases.find(row=>row.id===id);}
    return data;
  }
  async function task(id){
    const {data}=await f.request('/api/work-queue?workflow=incidents',200,{cookie:reviewer});
    return data.tasks.find(item=>item.sourceId===id);
  }
  const baseline=await open('Original case','broad');
  assert.equal(baseline.policyPin,null);
  assert.equal((await open('Invalid scope','customer-description',422)).code,'INVALID_CHOICE');
  await command('create',{},403,reviewer);
  await command('publish',{note:fake},403,analyst,{spoof:'reviewer'});
  await command('create');
  assert.equal(model.policy.releases[0].canEdit,true);
  await command('create',{},409);
  assert.equal(model.policy.activeVersion,null);
  const draftCase=await open('Policy not active during draft');
  assert.equal(draftCase.policyPin,null);
  const definition=structuredClone(model.policy.releases[0].definition);
  definition.title='Fictional scoped incident routes';
  const broadLow=def=>def.routes.find(row=>row.severity==='low'&&row.scopeClass==='broad');
  Object.assign(broadLow(definition),{branch:'elevated',reviewHours:3,noticeHours:7});
  for(const invalid of [
    {...definition,routes:definition.routes.slice(1)},
    {...definition,routes:[definition.routes[0],...definition.routes.slice(0,-1)]},
    {...definition,routes:definition.routes.map(row=>row.severity==='high'?{...row,branch:'standard'}:row)},
    {...definition,routes:definition.routes.map(row=>({...row,noticeHours:721}))},
    {...definition,routes:definition.routes.map(row=>({...row,reviewHours:'3'}))},
    {...definition,routes:definition.routes.map(row=>({...row,sendRealNotice:true}))}
  ])assert.equal((await command('edit',{definition:invalid},422)).code,'INVALID_INCIDENT_POLICY');
  await command('edit',{definition});
  await command('submit',{expectedRevision:0},409);
  await command('submit');
  await command('publish',{note:fake},422,reviewer,{body:{expectedRevision:model.policy.revision,note:'  '}});
  await command('return',{note:'Fictional request to document the exercise.'},200,reviewer);
  assert.equal(model.policy.releases[0].status,'draft');
  assert.equal(model.policy.activeVersion,null);
  await command('submit');
  await command('publish',{note:fake},200,reviewer);
  const published=model.policy.releases[0];
  assert.equal(model.policy.activeVersion,1);
  assert.match(published.hash,/^[a-f0-9]{64}$/);
  assert.equal(model.policy.releases[0].canReview,false);
  assert.equal(JSON.stringify(model.policy).includes(seats[0][0]),false);
  const old=await open('Pinned before version two','broad');
  const missingScope=await open('Older API omits scope');
  assert.equal(missingScope.scopeClass,'unknown');
  assert.deepEqual(old.policyPin,{version:1,sha256:published.hash});
  assert.equal(old.policyRoute,null);
  assert.equal((await advance(baseline.id,'triage',{severity:'low',note:fake})).branch,'standard');
  assert.equal((await task(baseline.id)).timing,'no-date');

  await command('create');
  const change=structuredClone(model.policy.releases[1].definition);
  Object.assign(broadLow(change),{branch:'standard',reviewHours:12,noticeHours:30});
  change.title='Fictional updated incident routes';
  await command('edit',{definition:change});
  await command('submit');
  await command('publish',{note:fake},200,reviewer);
  assert.equal(model.policy.activeVersion,2);
  assert.equal(model.policy.releases[0].hash,published.hash);
  const newCase=await open('New policy case','broad');
  const disconnected=(await f.request(api+'cases',200,{cookie:beta,workspace:'beta'})).data;
  assert.equal(disconnected.policy.activeVersion,null);
  assert.deepEqual(disconnected.cases,[]);
  const oldTriage=await advance(old.id,'triage',{severity:'low',note:fake});
  const newTriage=await advance(newCase.id,'triage',{severity:'low',note:fake});
  assert.equal(oldTriage.branch,'elevated');assert.equal(oldTriage.windows.reviewHours,3);
  assert.equal(newTriage.branch,'standard');assert.equal(newTriage.windows.reviewHours,12);
  assert.equal(newTriage.policyPin.version,2);
  const reclassified=await advance(missingScope.id,'triage',{severity:'low',scopeClass:'broad',note:fake});
  assert.equal(reclassified.scopeClass,'broad');
  assert.equal(reclassified.branch,'elevated');
  assert.equal(reclassified.policyPin.version,1);
  assert.equal(reclassified.windows.noticeHours,7);
  for(const row of [old,newCase]){
    await advance(row.id,'containment',{note:fake});
    await advance(row.id,'findings',{note:fake});
    await advance(row.id,'evidence',{kind:'general',reference:'SYN-INC101',note:fake});
  }
  assert.equal((await advance(old.id,'request-review',{},409)).code,'INVESTIGATION_INCOMPLETE');
  await advance(old.id,'evidence',{kind:'impact',reference:'SYN-INC102',note:fake});
  const firstReview=await advance(old.id,'request-review');
  assert.equal(firstReview.windows.reviewDueAt,hours(firstReview.updatedAt,3));
  assert.equal(firstReview.windows.reviewStatus,'pending');
  assert.equal((await task(old.id)).dueDate,firstReview.reviewDueAt.slice(0,10));
  assert.equal((await task(old.id)).owner,'reviewer');
  await advance(old.id,'decide',{decision:'required',note:fake},403,analyst);
  const returned=await advance(old.id,'decide',{decision:'more-information',note:fake},200,reviewer);
  assert.equal(returned.windows.reviewStatus,'completed-on-time');
  assert.equal(returned.windows.noticeDueAt,null);
  assert.equal((await task(old.id)).dueDate,null);
  await advance(old.id,'request-review',{},409);
  await advance(old.id,'findings',{note:'Updated fictional investigation.'});
  await advance(old.id,'request-review');
  const required=await advance(old.id,'decide',{decision:'required',note:fake},200,reviewer);
  assert.equal(required.windows.noticeDueAt,hours(required.review.at,7));
  assert.equal(required.windows.noticeStatus,'pending');
  assert.equal((await task(old.id)).dueDate,required.noticeDueAt.slice(0,10));
  assert.equal((await task(old.id)).owner,'analyst');
  const planned=await advance(old.id,'plan-notice',{reference:'SYN-PLAN01',note:fake});
  assert.equal(planned.noticePlan.sent,false);
  assert.equal(planned.windows.noticeStatus,'completed-on-time');
  await advance(old.id,'close',{note:fake});
  assert.equal(await task(old.id),undefined);
  const newReview=await advance(newCase.id,'request-review');
  assert.equal(newReview.reviewDueAt,hours(newReview.updatedAt,12));
  const notRequired=await advance(newCase.id,'decide',{decision:'not-required',note:fake},200,reviewer);
  assert.equal(notRequired.windows.noticeDueAt,null);
  await advance(newCase.id,'close',{note:fake});
  const {data:report}=await f.request('/api/audit/export',200,{cookie:reviewer});
  const publications=report.audit.filter(row=>row.action==='incident.policy.publish');
  assert.equal(publications.length,2);
  assert.ok(publications.every(row=>row.account===seats[1][0]));
  assert.ok(report.audit.some(row=>row.action==='incident.case.plan-notice'&&row.details.sent===false));
  const {data:generic}=await f.request('/api/state',200,{cookie:reviewer});
  assert.equal(JSON.stringify(generic).includes(change.title),false);
  await f.stop();await f.start();
  analyst=await f.login(seats[0]);
  model=await get();
  assert.equal(model.policy.activeVersion,2);
  assert.equal(model.cases.find(row=>row.id===old.id).policyPin.version,1);
  assert.equal(model.cases.find(row=>row.id===old.id).noticePlan.sent,false);
});

test('fail closed on altered policy pins and same-account approval; exact UTC timing boundaries',()=>{
  const state={incidentCases:[],audit:[]},events=(s,actor,action,p,id,details)=>s.audit.push({actor,action,id,details});
  const at='2027-01-05T23:00:00.000Z';
  const version=(action,actor,expectedRevision,account,extra={})=>policy.change(state,['incidents','policy',action],actor,{expectedRevision,...extra},events,account,at);
  version('create','analyst',0,'same-seat');
  assert.equal(policy.view(state,'analyst','other-seat').releases[0].canEdit,false);
  assert.throws(()=>version('submit','analyst',1,'other-seat'),{code:'POLICY_AUTHOR_REQUIRED'});
  version('submit','analyst',1,'same-seat');
  assert.throws(()=>version('publish','reviewer',2,'same-seat',{note:fake}),{code:'INDEPENDENT_REVIEW_REQUIRED'});
  version('publish','reviewer',2,'review-seat',{note:fake});
  assert.throws(()=>policy.route(state,{...policy.pin(state),sha256:'0'.repeat(64)},'limited','low'),{code:'INCIDENT_POLICY_INCONSISTENT'});
  state.incidentPolicyBook.releases[0].definition.routes[0].noticeHours+=1;
  assert.throws(()=>policy.pin(state),{code:'INCIDENT_POLICY_INCONSISTENT'});
  state.incidentCases=[{id:'expected',owner:'analyst',ownerAccount:'same-seat',stage:'review',revision:3}];
  assert.throws(()=>workflow.change(state,['incidents','cases','expected','decide'],'reviewer',{expectedRevision:3,decision:'required',note:fake},events,null,'same-seat'),
    {code:'INDEPENDENT_REVIEW_REQUIRED'});
  const due=policy.deadline(at,1),late='2027-01-06T00:00:00.001Z';
  assert.equal(due,'2027-01-06T00:00:00.000Z');
  assert.equal(policy.status(due,null,due),'pending');
  assert.equal(policy.status(due,null,late),'overdue');
  assert.equal(policy.status(due,due,late),'completed-on-time');
  assert.equal(policy.status(due,late,late),'completed-late');
  assert.equal(policy.taskDate({stage:'review',reviewDueAt:due}),'2027-01-06');
});

test('Chromium: policy author and reviewer use the full editor, approval and configured response journey', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:35_000
},async t=>{
  const f=await fixture(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}}),reviewer=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[],external=[];
  async function login(browserPage,[account,workspace]){
    browserPage.setDefaultTimeout(7000);
    browserPage.on('pageerror',error=>errors.push(error.message));
    await browserPage.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.url)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    await browserPage.goto(f.url);
    await browserPage.getByLabel('Test account',{exact:true}).fill(account);
    await browserPage.getByLabel('Workspace ID',{exact:true}).fill(workspace);
    await browserPage.getByLabel('Local access code',{exact:true}).fill(f.codes[account]);
    await browserPage.getByRole('button',{name:'Sign in',exact:true}).click();
    await browserPage.getByRole('button',{name:'Incidents',exact:true}).click();
    await browserPage.getByRole('heading',{name:'Synthetic incident workflow policy',exact:true}).waitFor();
  }
  const exact=(scope,name)=>scope.getByRole('button',{name,exact:true});
  const heading=(scope,name)=>scope.getByRole('heading',{name,exact:true});
  const set=(scope,label,value)=>scope.getByLabel(label,{exact:true}).fill(value);
  async function reveal(scope,caption){
    const summary=scope.locator('summary').getByText(caption,{exact:true});
    await summary.click();
    return summary.locator('..');
  }
  async function navigate(browserPage,name){
    await exact(browserPage,name).click();
  }
  await login(page,seats[0]);
  await exact(page,'Draft incident policy').click();
  await heading(page,'Policy version 1 · Draft').waitFor();
  const editor=await reveal(page,'Edit routing and windows');
  await set(editor,'Fictional policy title','Browser broad-scope routing');
  assert.equal(await editor.locator('fieldset').count(),12);
  const route=editor.locator('fieldset').filter({hasText:'Low / Broad'});
  await route.getByLabel('Investigation branch').selectOption('standard');
  await set(route,'Review window (hours)','3');
  await set(route,'Mock notice window (hours)','7');
  const critical=editor.locator('fieldset').filter({hasText:'Critical / Limited'});
  assert.equal(await critical.locator('option[value="standard"]').isDisabled(),true);
  await exact(editor,'Save incident routing').click();
  await page.getByText('Browser broad-scope routing',{exact:true}).waitFor();
  await exact(page,'Submit incident policy').click();
  await heading(page,'Policy version 1 · Review').waitFor();
  await login(reviewer,seats[1]);
  await reveal(reviewer,'Routing and windows');
  await reviewer.getByText('Low / Broad · Standard · review 3 h · mock notice 7 h',{exact:true}).waitFor();
  assert.equal(await exact(reviewer,'Draft incident policy').count(),0);
  const returnForm=await reveal(reviewer,'Return incident policy');
  await set(returnForm,'Fictional policy review rationale','Fictional: verify timing labels before publication.');
  await exact(returnForm,'Return incident policy').click();
  await heading(reviewer,'Policy version 1 · Draft').waitFor();
  await page.reload();await navigate(page,'Incidents');
  await exact(page,'Submit incident policy').click();
  await heading(page,'Policy version 1 · Review').waitFor();
  await reviewer.reload();await navigate(reviewer,'Incidents');
  const publishForm=await reveal(reviewer,'Publish incident policy locally');
  await set(publishForm,'Fictional policy review rationale','Fictional timing labels verified.');
  await exact(publishForm,'Publish incident policy locally').click();
  await reviewer.getByText('Active policy version 1',{exact:true}).waitFor();

  await page.reload();await navigate(page,'Incidents');
  const title='Fictional broad incident with configured targets';
  await set(page,'Fictional incident title',title);
  await set(page,'Fictional affected scope',fake);
  await page.getByLabel('Affected scope classification').selectOption('broad');
  await exact(page,'Log incident').click();
  const record=browserPage=>browserPage.locator('#incident-view article').filter({has:heading(browserPage,title)});
  const card=record(page);
  await card.getByText('Pinned policy version 1 · Broad scope',{exact:true}).waitFor();
  async function action(scope,caption,fields,after){
    const panel=await reveal(scope,caption);
    for(const [label,value,type] of fields)await panel.getByLabel(label,{exact:type!=='select'})[type==='select'?'selectOption':'fill'](value);
    await exact(panel,caption).click();
    await scope.getByText(after,{exact:true}).waitFor();
  }
  await action(card,'Record severity',[['Severity','low','select'],['Triage scope classification','broad','select'],['Fictional triage rationale',fake]],'Severity: Low · Standard investigation');
  await card.getByText('Configured windows: review 3 h · mock notice 7 h',{exact:true}).waitFor();
  await action(card,'Record containment',[['Fictional containment',fake]],'Containment: '+fake);
  await action(card,'Record investigation findings',[['Fictional findings',fake]],'Findings: '+fake);
  await action(card,'Add evidence reference',[['Fictional reference such as SYN-CASE01','SYN-WIN01'],['Evidence type','general','select'],['Fictional evidence note',fake]],'Evidence references (1)');
  await action(card,'Request notice review',[],'Review');
  await card.getByText('Review target ·',{exact:false}).waitFor();
  const reviewTarget=await card.locator('time').getAttribute('datetime');
  assert.ok(new Date(reviewTarget).getTime()>Date.now());
  await reviewer.reload();await navigate(reviewer,'Incidents');
  const reviewed=record(reviewer);
  await action(reviewed,'Record simulated notice decision',[['Simulated notice decision','required','select'],['Fictional reviewer rationale',fake]],'Notice planning');
  await reviewed.getByText('Mock notice target ·',{exact:false}).waitFor();
  await page.reload();await navigate(page,'Incidents');
  await action(card,'Record mock notice plan',[['Fictional plan ID such as SYN-PLAN01','SYN-WIN02'],['Mock plan summary',fake]],'Mock notice plan SYN-WIN02 (not sent): '+fake);
  await action(card,'Close incident',[['Fictional closure rationale',fake]],'Closed');
  await page.reload();await navigate(page,'Incidents');
  await record(page).getByText('Closed',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
