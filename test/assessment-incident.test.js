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
const privateAnswer='Fictional detailed questionnaire text must not copy to the incident.';
const enhancedVendor='Fictional enhanced vendor private name';
const bridge=id=>'assessments/'+id+'/linked-incident';
const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
const see=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();

async function fixture(t,demo=false){
  const root=await mkdtemp(join(tmpdir(),'mvw-assessment-incident-'));
  const roles=['analyst','reviewer','case-operator'];
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const opts=demo?{dataFile:join(root,'demo.json')}:{sqliteFile:join(root,'mvw.sqlite'),isolated:{
    root:join(root,'workspaces'),workspaces:[{id:'alpha',label:'Sample Alpha'},{id:'beta',label:'Sample Beta'}],
    accounts:roles.map(role=>({id:'sample-'+role,codeHash:codeHash(codes[role]),memberships:{alpha:role,beta:role}}))
  }};
  let server,url;
  async function start(){
    server=createServer(opts).listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  async function api(path,{cookie,body,workspace='alpha',status=200,actor}={}){
    const target=url+'/api/'+path+(!demo&&workspace?(path.includes('?')?'&':'?')+'workspace='+workspace:'');
    const r=await fetch(target,{
      method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{}),
        ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=await r.json();
    if(status!==null)assert.equal(r.status,status,target+' '+JSON.stringify(data));
    assert.equal(r.headers.get('cache-control'),'no-store');
    return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const token=async(role,workspace='alpha')=>(await api('session/login',{workspace:null,
    body:{account:'sample-'+role,workspace,code:codes[role]}})).cookie;
  async function example(a,r,{configured=false}={}){
    if(configured){
      await api('assessment-config/create',{cookie:a,body:{expectedRevision:0}});
      await api('assessment-config/submit',{cookie:a,body:{expectedRevision:1}});
      await api('assessment-config/publish',{cookie:r,body:{expectedRevision:2,note:'Independent fictional configuration approval.'}});
    }
    const project='Fictional cross-workflow project';
    const s=(await api('projects',{cookie:a,body:{name:project}})).data;
    const projectId=s.projects.find(x=>x.name===project).id;
    const make=async(name,handlesSensitiveData,usesAI)=>{
      const state=(await api('vendors',{cookie:a,body:{projectId,name,handlesSensitiveData,usesAI}})).data;
      const vendor=state.vendors.find(x=>x.name===name);
      return state.assessments.filter(x=>x.vendorId===vendor.id);
    };
    const [enhanced]=await make(enhancedVendor,true,false);
    const [standard,ai]=await make('Fictional unrelated vendor',false,true);
    return {project,projectId,enhanced,standard,ai};
  }
  async function approve(a,r,record){
    const answers=Object.fromEntries(record.questionnaire.questions.filter(q=>!q.when).map(q=>[q.id,q.kind==='choice'?'No':privateAnswer]));
    const path='assessments/'+record.id;
    const submitted=(await api(path+'/submit',{cookie:a,body:{expectedRevision:record.revision,answers}})).data.assessments.find(x=>x.id===record.id);
    return (await api(path+'/approve',{cookie:r,body:{expectedRevision:submitted.revision,reason:'Independent approval of the fictional intake.'}})).data.assessments.find(x=>x.id===record.id);
  }
  return {codes,api,token,example,approve,get url(){return url},restart:async()=>{await stop();await start();}};
}

test('assessment incident: the exact approval yields one atomic synthetic incident and stable provenance across races and restart',async t=>{
  const f=await fixture(t),a=await f.token('analyst'),r=await f.token('reviewer'),c=await f.token('case-operator'),b=await f.token('analyst','beta');
  const {enhanced,standard,ai,projectId}=await f.example(a,r);
  const payload=(assessment,expectedRevision=assessment.revision)=>({expectedRevision});
  const send=(assessment,cookie,body=payload(assessment),status=200,workspace='alpha')=>f.api(bridge(assessment.id),{cookie,workspace,body,status});
  const denied=await send(enhanced,a,payload(enhanced),409);
  assert.equal(denied.data.code,'APPROVED_ASSESSMENT_REQUIRED');
  const approved=await f.approve(a,r,enhanced);
  for(const unrelated of [await f.approve(a,r,standard),await f.approve(a,r,ai)]){
    assert.equal((await send(unrelated,a,payload(unrelated),409)).data.code,'ASSESSMENT_TYPE_REQUIRED');
  }
  await send(approved,undefined,payload(approved),401);
  await send(approved,r,payload(approved),403);
  await send(approved,c,payload(approved),403);
  await send(approved,b,payload(approved),403);
  await send(approved,b,payload(approved),404,'beta');
  await send(approved,a,{...payload(approved),scope:privateAnswer},422);
  await send(approved,a,{...payload(approved),incidentId:'made-up'},422);
  await send(approved,a,payload(approved,approved.revision-1),409);
  await f.api(bridge(approved.id)+'?copy=private',{cookie:a,body:payload(approved),status:422});
  const before=(await f.api('incidents/cases',{cookie:a})).data;
  assert.deepEqual(before.cases,[]);
  const race=await Promise.all(Array.from({length:5},()=>send(approved,a,payload(approved),null)));
  assert.deepEqual(race.map(x=>x.status).sort(),[200,200,200,200,201]);
  assert.equal(race.filter(x=>x.data.created).length,1);
  const {incidentId,origin}=race.find(x=>x.data.created).data;
  assert.ok(race.every(x=>x.data.incidentId===incidentId));
  const audit=(await f.api('audit/export',{cookie:r})).data.audit;
  const approval=audit.find(e=>e.action==='assessment.approved'&&e.entityId===approved.id);
  assert.deepEqual(origin,{assessmentId:approved.id,assessmentRevision:approved.revision,projectId,
    questionnaireId:'sensitive',questionnaireVersion:1,workflowInstanceId:approved.workflowInstanceId,
    workflowDefinitionId:approved.routing.workflowId,workflowDefinitionVersion:approved.workflowDefinitionVersion,
    workflowRevision:approved.workflowRevision,approvalEventId:approval.id});
  const incidents=(await f.api('incidents/cases',{cookie:a})).data.cases;
  assert.equal(incidents.length,1);
  const [incident]=incidents;
  assert.equal(incident.id,incidentId);
  assert.deepEqual(incident.assessmentOrigin,origin);
  assert.equal(incident.stage,'logged');
  assert.equal(incident.scopeClass,'unknown');
  assert.equal(incident.severity,null);
  assert.equal(incident.noticePlan,null);
  assert.deepEqual(incident.evidence,[]);
  assert.doesNotMatch(JSON.stringify(incident),/Fictional detailed questionnaire|Fictional enhanced vendor private name/);
  assert.equal(audit.filter(e=>e.action==='incident.case.opened'&&e.entityId===incidentId&&e.account==='sample-analyst').length,1);
  assert.equal((await f.api('incidents/cases',{cookie:b,workspace:'beta'})).data.cases.length,0);
  assert.equal((await f.api('state',{cookie:c})).data.assessmentIncidentLinks,undefined);
  assert.deepEqual((await f.api('state',{cookie:r})).data.assessmentIncidentLinks,[
    {assessmentId:approved.id,assessmentRevision:approved.revision,incidentId}
  ]);
  assert.deepEqual((await f.api('state',{cookie:a})).data.assessments.find(x=>x.id===approved.id),approved);
  await f.restart();
  const fresh=await f.token('analyst'),reopened=(await send(approved,fresh)).data;
  assert.deepEqual(reopened,{created:false,incidentId,origin});
  assert.deepEqual((await f.api('incidents/cases',{cookie:fresh})).data.cases[0].assessmentOrigin,origin);
  const secondAudit=(await f.api('audit/export',{cookie:await f.token('reviewer')})).data.audit;
  assert.equal(secondAudit.filter(e=>e.action==='incident.case.opened'&&e.entityId===incidentId).length,1);
});

test('assessment incident does not enable synthetic demo identity writes',async t=>{
  const f=await fixture(t,true);
  await f.api(bridge('fake-assessment'),{actor:'analyst',body:{expectedRevision:2},status:404});
  assert.deepEqual((await f.api('incidents/cases')).data.cases,[]);
});

test('Chromium: analyst deliberately logs linked incident from approved configured DPIA and follows two-way exact record navigation',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Chromium and Playwright',timeout:40_000
},async t=>{
  const f=await fixture(t),a=await f.token('analyst'),r=await f.token('reviewer');
  const {project,enhanced,standard}=await f.example(a,r,{configured:true});
  const approved=await f.approve(a,r,enhanced),pia=await f.approve(a,r,standard);
  const {chromium}=require('playwright'),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const errors=[],external=[];
  t.after(()=>browser.close());
  async function sign(p,role){
    p.setDefaultTimeout(6500);p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.url)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    await p.goto(f.url);
    await p.getByLabel('Test account').fill('sample-'+role);
    await p.getByLabel('Workspace ID').fill('alpha');
    await p.getByLabel('Local access code').fill(f.codes[role]);
    await b(p,'Sign in').click();
  }
  async function source(p){
    await b(p,'Assessments').click();
    await b(p,project).click();
    await see(p,'Configuration v1 · Rule sensitive-review');
  }
  const analyst=await browser.newPage(),reviewer=await browser.newPage();
  await sign(analyst,'analyst');
  await source(analyst);
  await sign(reviewer,'reviewer');
  await source(reviewer);
  const aCard=analyst.locator('#work-record-'+approved.id),rCard=reviewer.locator('#work-record-'+approved.id);
  const summary='Log an assessment-linked incident',label='Log linked incident';
  const control=scope=>scope.locator('summary').filter({hasText:new RegExp('^'+summary+'$')});
  assert.equal(await control(analyst.locator('#work-record-'+pia.id)).count(),0);
  assert.equal(await control(rCard).count(),0);
  await control(aCard).press('Space');
  assert.equal(await control(aCard).evaluate(e=>e.parentElement.open),true);
  const confirm=aCard.getByRole('checkbox',{name:/Confirm this fictional follow-up/});
  const before=await f.api('incidents/cases',{cookie:a});
  assert.deepEqual(before.data.cases,[]);
  await b(aCard,label).press('Enter');
  assert.equal(await confirm.evaluate(e=>e.validity.valueMissing),true);
  assert.deepEqual((await f.api('incidents/cases',{cookie:a})).data.cases,[]);
  await confirm.check();
  const post=analyst.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname.endsWith('/linked-incident'));
  await b(aCard,label).press('Enter');
  const response=await post;
  assert.equal(response.status(),201);
  const linked=await response.json();
  assert.equal(linked.origin.questionnaireId,'configured-dpia');
  const incident=analyst.locator('#work-record-'+linked.incidentId);
  await h(incident,'Assessment follow-up · '+approved.id.slice(0,8)).waitFor();
  await see(incident,'Logged');
  await see(incident,'Linked to independently approved assessment revision '+approved.revision+' · Questionnaire v1 · Workflow v1');
  assert.equal(await incident.evaluate(el=>el===document.activeElement),true);
  assert.doesNotMatch(await incident.innerText(),/Fictional detailed questionnaire|Fictional enhanced vendor private name/);
  const reveal=incident.locator('summary').filter({hasText:/^Record severity$/});
  await reveal.press('Space');
  assert.equal(await reveal.evaluate(el=>el.parentElement.open),true);
  await incident.getByLabel('Severity').selectOption('low');
  await incident.getByLabel('Fictional triage rationale').fill('Fictional independent incident triage.');
  await b(incident,'Record severity').press('Enter');
  await see(incident,'Investigating');
  assert.deepEqual((await f.api('incidents/cases',{cookie:a})).data.cases[0].assessmentOrigin,linked.origin);
  await b(incident,'View approved source assessment').press('Enter');
  await b(aCard,'Open linked incident').waitFor();
  assert.equal(await aCard.evaluate(el=>el===document.activeElement),true);
  await analyst.reload();
  await source(analyst);
  await b(aCard,'Open linked incident').press('Enter');
  await h(incident,'Assessment follow-up · '+approved.id.slice(0,8)).waitFor();
  assert.equal(await analyst.locator('#incident-view article').filter({hasText:'Assessment follow-up ·'}).count(),1);
  await reviewer.reload();
  await source(reviewer);
  await b(rCard,'Open linked incident').waitFor();
  assert.equal(await control(rCard).count(),0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(external,[]);
});
