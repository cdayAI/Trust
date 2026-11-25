'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const base='/api/incidents/cases',policy='/api/incidents/policy';
const firstTitle='Fictional case pinned to 1',secondTitle='Fictional case pinned to 2',outsideTitle='Independent Orchard fixture';
const note='Fictional tabletop notes only.';
const b=(s,name)=>s.getByRole('button',{name,exact:true});
const h=(s,name)=>s.getByRole('heading',{name,exact:true});
const see=(s,value)=>s.getByText(value,{exact:true}).waitFor();
const plus=(time,hours)=>new Date(Date.parse(time)+hours*3600000).toISOString();

async function setup(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-incident-policy-stale-'));
  const child=spawn(process.execPath,[resolve(__dirname,'../start-release.js'),'--port','0'],{
    cwd:room,env:{...process.env,TMPDIR:room,TMP:room,TEMP:room},stdio:['ignore','pipe','pipe']
  });
  const exit=once(child,'exit');
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}
    await rm(room,{recursive:true,force:true,maxRetries:2});
  });
  const announcement=await new Promise((ok,fail)=>{
    let buffer='';
    const timer=setTimeout(()=>fail(Error('Release start deadline.')),20_000);
    exit.then(()=>{clearTimeout(timer);fail(Error('Release exited before starting.'));},fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.includes('\n')){clearTimeout(timer);ok(buffer.split('\n')[0]);}
    });
    child.stderr.resume();
  });
  const live=JSON.parse(announcement);
  assert.equal(live.status,'ready');
  assert.match(live.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const rel=relative(room,live.accessFile);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  const access=JSON.parse(await readFile(live.accessFile,'utf8'));
  assert.equal(access.mode,'local-synthetic-only');
  const seat=(workspace,role)=>access.staff.find(s=>s.memberships[workspace]===role);

  async function request(path,{workspace='harbor',cookie,body,status=200}={}){
    const endpoint=new URL(path,live.url);
    if(workspace)endpoint.searchParams.set('workspace',workspace);
    const res=await fetch(endpoint,{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:live.url,'Content-Type':'application/json'})},
      signal:AbortSignal.timeout(7000)
    });
    assert.equal(res.status,status,path);
    const raw=Buffer.from(await res.arrayBuffer());
    return {raw,data:res.headers.get('content-type')?.startsWith('application/json')?JSON.parse(raw):null,
      cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(role,workspace='harbor'){
    const {id:account,code}=seat(workspace,role);
    return (await request('/api/session/login',{body:{account,workspace,code},workspace:null})).cookie;
  }
  return {url:live.url,seat,request,login};
}

test('composed Chromium: conflicting incident policy and case reviews preserve pinned deadlines and never send',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:65_000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const author=await f.login('analyst'),review=await f.login('reviewer'),orchardAuthor=await f.login('analyst','orchard'),orchardReview=await f.login('reviewer','orchard');
  const errors=[],external=[],browserPosts=[];
  async function seedPolicy({cookie,reviewer,workspace='harbor',title,branch,reviewHours,noticeHours,publish}){
    const action=async(verb,revision,body={},who=cookie)=>(await f.request(policy+'/'+verb,{workspace,cookie:who,
      body:{expectedRevision:revision,...body}})).data.policy;
    const current=(await f.request(base,{workspace,cookie})).data.policy;
    const draft=await action('create',current.revision),definition=structuredClone(draft.releases.at(-1).definition);
    definition.title=title;
    Object.assign(definition.routes.find(row=>row.severity==='low'&&row.scopeClass==='broad'),{branch,reviewHours,noticeHours});
    const edited=await action('edit',draft.revision,{definition});
    const waiting=await action('submit',edited.revision);
    return publish?action('publish',waiting.revision,{note},reviewer):waiting;
  }
  async function visit(role,workspace='harbor'){
    const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    p.setDefaultTimeout(6500);
    p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.origin!==f.url){external.push(url.origin);return route.abort();}
      if(req.method()==='POST'&&!url.pathname.startsWith('/api/session/'))browserPosts.push(url.pathname);
      return route.continue();
    });
    const {id,code}=f.seat(workspace,role);
    await p.goto(f.url);
    await p.getByLabel('Test account',{exact:true}).fill(id);
    await p.getByLabel('Workspace ID',{exact:true}).fill(workspace);
    await p.getByLabel('Local access code',{exact:true}).fill(code);
    await b(p,'Sign in').press('Enter');
    await openIncidents(p);
    return p;
  }
  async function openIncidents(p){
    await b(p,'Incidents').press('Enter');
    await h(p,'Synthetic incident workflow policy').waitFor();
  }
  async function reopen(p){await p.reload();await openIncidents(p);}
  const card=(p,title)=>p.locator('#incident-view article').filter({has:h(p,title)});
  const set=(scope,name,value)=>scope.getByLabel(name,{exact:true}).fill(value);
  const select=(scope,name,value)=>scope.getByLabel(name).selectOption(value);
  async function focus(locator){
    await locator.waitFor();
    assert.equal(await locator.evaluate(node=>node===document.activeElement),true,
      'expected focus on '+await locator.textContent()+'; found '+await locator.page().evaluate(()=>document.activeElement.tagName));
  }
  async function disclosure(scope,text){
    const summary=scope.locator('summary').filter({hasText:new RegExp('^'+text+'$')});
    await summary.press('Enter');
    const details=summary.locator('..');
    assert.equal(await details.getAttribute('open'),'');
    return details;
  }
  async function submit(p,scope,control,path,status=200){
    const pending=p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
    await b(scope,control).press('Enter');
    const response=await pending;
    assert.equal(response.status(),status,control);
    assert.equal(new URL(response.url()).searchParams.get('workspace'),'harbor');
    return {data:await response.json(),body:response.request().postDataJSON()};
  }
  async function recover(p,scope,message,target){
    await p.getByText(message).waitFor();
    assert.notEqual(await p.evaluate(()=>document.activeElement.tagName),'BODY','A stale keyboard review dropped focus to the document body.');
    await focus(scope.getByRole('alert').filter({hasText:message}));
    await p.keyboard.press('Tab');
    const reload=b(scope,'Reload incidents');
    await focus(reload);
    const pending=p.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname===base);
    await reload.press('Enter');
    const reply=await pending;
    assert.equal(reply.status(),200);
    assert.equal(new URL(reply.url()).searchParams.get('workspace'),'harbor');
    await focus(target);
    assert.equal(await scope.getByRole('alert').count(),0);
  }
  async function intake(p,title){
    await set(p,'Fictional incident title',title);
    await set(p,'Fictional affected scope',note);
    await select(p,'Affected scope classification','broad');
    const {data}=await submit(p,p,'Log incident',base);
    await h(card(p,title),title).waitFor();
    return data.cases.find(row=>row.title===title);
  }
  const caseAt=(data,id)=>data.cases.find(row=>row.id===id);
  async function caseAction(p,record,caption,action,fields=[],status=200){
    const panel=await disclosure(card(p,record.title),caption);
    for(const [name,value,type] of fields)await (type==='select'?select:set)(panel,name,value);
    return submit(p,panel,caption,base+'/'+record.id+'/'+action,status);
  }
  async function seedCaseAction(id,action,body){
    const current=caseAt((await f.request(base,{cookie:author})).data,id);
    return caseAt((await f.request(base+'/'+id+'/'+action,{cookie:author,body:{expectedRevision:current.revision,...body}})).data,id);
  }

  const v1=await seedPolicy({cookie:author,reviewer:review,title:'Harbor early version',branch:'elevated',reviewHours:3,noticeHours:7,publish:true});
  const orchard=await seedPolicy({cookie:orchardAuthor,reviewer:orchardReview,workspace:'orchard',title:'Independent Orchard timing',branch:'standard',reviewHours:24,noticeHours:48,publish:true});
  await f.request(base,{workspace:'orchard',cookie:orchardAuthor,body:{title:outsideTitle,scope:note,scopeClass:'broad'}});
  const analyst=await visit('analyst');
  const first=await intake(analyst,firstTitle);
  assert.deepEqual(first.policyPin,{version:1,sha256:v1.releases.at(-1).hash});
  await see(card(analyst,firstTitle),'Pinned policy version 1 · Broad scope');

  const waiting=await seedPolicy({cookie:author,title:'Harbor amended version',branch:'standard',reviewHours:12,noticeHours:30});
  assert.equal(waiting.activeVersion,1);
  const reviewer=await visit('reviewer'),stale=await visit('reviewer');
  const policyReview='Policy version 2 · Review';
  const winningPanel=await disclosure(card(reviewer,policyReview),'Publish incident policy locally');
  const stalePanel=await disclosure(card(stale,policyReview),'Return incident policy');
  await set(winningPanel,'Fictional policy review rationale','Approved amended fictional matrix.');
  await set(stalePanel,'Fictional policy review rationale','Conflicting request to return fictional matrix.');
  const published=await submit(reviewer,winningPanel,'Publish incident policy locally',policy+'/publish');
  const rejected=await submit(stale,stalePanel,'Return incident policy',policy+'/return',409);
  assert.equal(rejected.data.code,'STALE_REVISION');
  assert.equal(rejected.body.expectedRevision,published.body.expectedRevision);
  assert.equal(published.data.policy.activeVersion,2);
  assert.equal(published.data.policy.releases[0].hash,v1.releases.at(-1).hash);
  await recover(stale,card(stale,policyReview),'This incident policy changed. Reload before retrying.',h(stale,'Synthetic incident workflow policy'));
  await h(stale,'Policy version 2 · Published').waitFor();
  assert.equal(await b(stale,'Return incident policy').count(),0);
  assert.equal(await h(stale,policyReview).count(),0);
  await reopen(analyst);
  const second=await intake(analyst,secondTitle);
  assert.deepEqual(second.policyPin,{version:2,sha256:published.data.policy.releases.at(-1).hash});
  assert.notEqual(second.policyPin.sha256,first.policyPin.sha256);
  for(const [record,branch,hours,noticeHours] of [[first,'elevated',3,7],[second,'standard',12,30]]){
    const {data}=await caseAction(analyst,record,'Record severity','triage',[
      ['Severity','low','select'],['Triage scope classification','broad','select'],['Fictional triage rationale',note]
    ]);
    const routed=caseAt(data,record.id);
    assert.equal(routed.branch,branch);
    await see(card(analyst,record.title),'Configured windows: review '+hours+' h · mock notice '+noticeHours+' h');
    await seedCaseAction(record.id,'containment',{note});
    await seedCaseAction(record.id,'findings',{note});
    await seedCaseAction(record.id,'evidence',{kind:'general',reference:'SYN-RACE001',note});
  }
  await reopen(analyst);
  assert.equal(await card(analyst,firstTitle).getByText('Request notice review',{exact:true}).count(),0);
  await card(analyst,secondTitle).locator('summary').filter({hasText:'Request notice review'}).waitFor();
  await caseAction(analyst,first,'Add evidence reference','evidence',[
    ['Fictional reference such as SYN-CASE01','SYN-RACE002'],['Evidence type','impact','select'],['Fictional evidence note',note]
  ]);
  for(const [record,hours] of [[first,3],[second,12]]){
    const {data}=await caseAction(analyst,record,'Request notice review','request-review');
    const row=caseAt(data,record.id);
    assert.equal(row.stage,'review');
    assert.equal(row.windows.reviewDueAt,plus(row.updatedAt,hours));
    const deadline=card(analyst,record.title).locator('time');
    await deadline.waitFor();
    assert.equal(await deadline.getAttribute('datetime'),row.windows.reviewDueAt);
  }

  await reopen(reviewer);await reopen(stale);
  const more=await caseAction(reviewer,first,'Record simulated notice decision','decide',[
    ['Simulated notice decision','more-information','select'],['Fictional reviewer rationale','Fictional evidence needs clarification.']
  ]);
  const refused=await caseAction(stale,first,'Record simulated notice decision','decide',[
    ['Simulated notice decision','required','select'],['Fictional reviewer rationale','Conflicts with prior fictional review.']
  ],409);
  assert.equal(refused.data.code,'STALE_REVISION');
  assert.equal(more.body.expectedRevision,refused.body.expectedRevision);
  const returned=caseAt(more.data,first.id);
  assert.equal(returned.windows.noticeDueAt,null);
  assert.equal(returned.windows.reviewStatus,'completed-on-time');
  await recover(stale,card(stale,firstTitle),'This incident changed. Reload before retrying.',h(card(stale,firstTitle),firstTitle));
  await see(card(stale,firstTitle),'Simulated notice decision: more information. Fictional evidence needs clarification.');
  assert.equal(await card(stale,firstTitle).getByText('Record simulated notice decision',{exact:true}).count(),0);

  await reopen(analyst);
  assert.equal(await card(analyst,firstTitle).getByText('Request notice review',{exact:true}).count(),0);
  await caseAction(analyst,first,'Record investigation findings','findings',[['Fictional findings','Revised fictional evidence findings.']]);
  const resubmit=await caseAction(analyst,first,'Request notice review','request-review');
  const secondReview=caseAt(resubmit.data,first.id);
  assert.ok(secondReview.revision>returned.revision);
  assert.equal(secondReview.windows.reviewDueAt,plus(secondReview.updatedAt,3));
  assert.equal(secondReview.windows.reviewStatus,'pending');
  await reopen(stale);
  const required=await caseAction(stale,first,'Record simulated notice decision','decide',[
    ['Simulated notice decision','required','select'],['Fictional reviewer rationale','Mock plan required; no notice sent.']
  ]);
  const decision=caseAt(required.data,first.id);
  assert.equal(decision.review.mode,'simulation-only');
  assert.equal(decision.windows.noticeDueAt,plus(decision.review.at,7));
  assert.equal(decision.windows.noticeStatus,'pending');
  const task=(await f.request('/api/work-queue?workflow=incidents',{cookie:author})).data.tasks.find(row=>row.sourceId===first.id);
  assert.equal(task.dueDate,decision.windows.noticeDueAt.slice(0,10));
  await reopen(analyst);
  const mock=await caseAction(analyst,first,'Record mock notice plan','plan-notice',[
    ['Fictional plan ID such as SYN-PLAN01','SYN-RACEPLAN'],['Mock plan summary',note]
  ]);
  const planned=caseAt(mock.data,first.id);
  assert.equal(planned.noticePlan.sent,false);
  assert.equal(planned.windows.noticeStatus,'completed-on-time');
  await reopen(analyst);
  await see(card(analyst,firstTitle),'Mock notice plan SYN-RACEPLAN (not sent): '+note);
  assert.equal(caseAt((await f.request(base,{cookie:author})).data,first.id).noticePlan.sent,false);
  const firstPath=base+'/'+first.id,secondPath=base+'/'+second.id;
  assert.deepEqual(browserPosts,[base,policy+'/publish',policy+'/return',base,
    firstPath+'/triage',secondPath+'/triage',firstPath+'/evidence',
    firstPath+'/request-review',secondPath+'/request-review',
    firstPath+'/decide',firstPath+'/decide',firstPath+'/findings',
    firstPath+'/request-review',firstPath+'/decide',firstPath+'/plan-notice']);


  const outside=await visit('reviewer','orchard');
  await see(outside,'Independent Orchard timing');
  await see(card(outside,outsideTitle),'Pinned policy version 1 · Broad scope');
  assert.equal(await h(outside,firstTitle).count(),0);
  assert.equal(await h(outside,secondTitle).count(),0);
  const own=(await f.request(base,{workspace:'orchard',cookie:orchardReview})).data;
  assert.equal(own.policy.activeVersion,1);
  assert.deepEqual(own.cases.map(row=>row.title),[outsideTitle]);
  assert.equal(own.cases[0].policyPin.sha256,orchard.releases.at(-1).hash);
  assert.notEqual(own.cases[0].policyPin.sha256,first.policyPin.sha256);
  const audit=(await f.request('/api/audit/export',{cookie:review})).data.audit;
  assert.deepEqual(audit.filter(e=>e.action==='incident.policy.publish').map(e=>e.details.version),[1,2]);
  assert.deepEqual(audit.filter(e=>e.entityId===first.id&&e.action==='incident.case.decide').map(e=>e.details.decision),['more-information','required']);
  const planEvents=audit.filter(e=>e.entityId===first.id&&e.action==='incident.case.plan-notice');
  assert.equal(planEvents.length,1);
  assert.equal(planEvents[0].details.sent,false);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
