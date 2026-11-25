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
const monitoring=require('../vendor-monitoring');
const base='/api/vendor-monitoring',cases=base+'/cases';
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
const titleA='Fictional lodging integration',titleB='Fictional reservations integration';
const named=(vendorId,title)=>({vendorId,engagementTitle:title,engagementScope:'Confirm scope for '+title,criticality:3,exposure:2});

test('SQLite verifies same-vendor service separation, stable lineage, per-engagement revisions and legacy coexistence',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vendor-engagements-'));
  const roster=[['scope-analyst','alpha','analyst'],['scope-reviewer','alpha','reviewer'],['case-worker','alpha','case-operator'],['beta-analyst','beta','analyst']];
  const codes=Object.fromEntries(roster.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(dir,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:roster.map(([id,space,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[space]:role}}))};
  let url,server;
  async function start(){server=createServer({isolated,sqliteFile:join(dir,'trust.sqlite')});url=await listen(server)}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true})});
  await start();
  async function request(route,{body,cookie,expected=200,spoof}={}){
    const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{
      ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(spoof?{'X-Demo-Actor':spoof}:{})
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,expected,route+': '+JSON.stringify(data));return {data,response};
  }
  const cookies={};
  async function login(){
    for(const [account,workspace,role] of roster){
      const {response}=await request('/api/session/login',{body:{account,workspace,code:codes[account]}});
      cookies[workspace==='beta'?'beta':role]=response.headers.get('set-cookie').split(';')[0];
    }
  }
  await login();
  const call=async(route,{body,role='analyst',workspace='alpha',expected=200,spoof}={})=>(await request(route+(route.includes('?')?'&':'?')+'workspace='+workspace,
    {body,cookie:cookies[role],expected,spoof})).data;
  const write=(route,body,role='analyst',expected=200,workspace='alpha')=>call(route,{body,role,expected,workspace});
  const project=(await write('/api/projects',{name:'Synthetic parallel project'})).projects[0];
  let intake=await write('/api/vendors',{projectId:project.id,name:'Fictional hotel infrastructure',usesAI:true,handlesSensitiveData:false});
  const [vendor]=intake.vendors,original=intake.assessments.map(a=>a.id).sort();
  assert.equal(original.length,2);
  await call(base,{role:'case-operator',expected:403,spoof:'analyst'});
  await write(cases,{...named(vendor.id,titleA),expectedRevision:0},'case-operator',403);
  await write(cases,{...named(vendor.id,titleA),expectedRevision:0},'beta',404,'beta');
  await write(cases,{...named(vendor.id,titleA),expectedRevision:0},'reviewer',403);
  await write(cases,{vendorId:vendor.id,engagementTitle:titleA,expectedRevision:0,criticality:1,exposure:1},'analyst',422);
  let model=await write(cases,{...named(vendor.id,titleA),expectedRevision:0});
  const get=title=>model.cases.find(c=>c.engagement?.title===title);
  const firstA=get(titleA),cycle=c=>c.cycles.at(-1);
  model=await write(cases,{...named(vendor.id,titleB),expectedRevision:model.revision});
  const firstB=get(titleB);
  assert.equal(firstA.revision,1);assert.equal(firstB.revision,1);
  assert.notEqual(firstA.id,firstB.id);
  assert.notEqual(cycle(firstA).assessmentCycleId,cycle(firstB).assessmentCycleId);
  assert.deepEqual(firstA.assessmentStatus.map(x=>x.type).sort(),['ai','privacy']);
  assert.equal(cycle(firstA).assessmentIds.some(id=>original.includes(id)||cycle(firstB).assessmentIds.includes(id)),false);
  assert.equal((await write(cases,{...named(vendor.id,titleA.toUpperCase()),expectedRevision:model.revision},'analyst',409)).code,'ENGAGEMENT_ALREADY_TRACKED');
  model=await write(cases,{vendorId:vendor.id,expectedRevision:model.revision,criticality:1,exposure:1});
  const legacy=model.cases.find(c=>!c.engagement);
  assert.equal(cycle(legacy).assessmentCycleId,null);
  assert.deepEqual(legacy.assessmentStatus.map(a=>a.id).sort(),original);
  assert.equal((await write(cases,{vendorId:vendor.id,expectedRevision:model.revision,criticality:1,exposure:1},'analyst',409)).code,'VENDOR_ALREADY_TRACKED');
  async function action(entry,op,body={},role='analyst',expected=200,workspace='alpha'){
    const next=await write(cases+'/'+entry.id+'/'+op,{expectedRevision:entry.revision??model.revision,...body},role,expected,workspace);
    if(expected===200)model=next;
    return expected===200?model.cases.find(c=>c.id===entry.id):next;
  }
  const evidence={reference:'SYN-SHARED01',note:'Fictional cycle evidence'};
  const A=await action(firstA,'evidence',{...evidence,note:'Lodging-only evidence'});
  const B=await action(firstB,'evidence',{...evidence,note:'Reservations-only evidence'});
  assert.equal(A.revision,2);assert.equal(B.revision,2);
  assert.notEqual(cycle(A).evidence[0].id,cycle(B).evidence[0].id);
  assert.equal(cycle(A).evidence[0].engagementId,firstA.id);
  assert.equal(cycle(B).evidence[0].assessmentCycleId,cycle(firstB).assessmentCycleId);
  assert.equal((await action(firstA,'evidence',{...evidence,reference:'SYN-OLD01'},'analyst',409)).code,'STALE_REVISION');
  assert.equal((await action(B,'submit',{},'analyst',409)).code,'ASSESSMENTS_NOT_APPROVED');
  await call(base,{role:'beta',expected:403,workspace:'alpha'});
  const localState=await call('/api/state');
  const draftSurvey=Object.fromEntries(localState.assessments.map(x=>[x.id,x]));
  async function approve(id){
    const row=draftSurvey[id],answers={summary:'Fictional risk review',safeguards:'Fictional safeguards'};
    if(row.type==='ai')answers.automatedAction='No';else answers.externalSharing='No';
    const route='/api/assessments/'+id;
    const saved=await write(route+'/submit',{expectedRevision:row.revision,answers});
    const submitted=saved.assessments.find(a=>a.id===id);
    await write(route+'/approve',{expectedRevision:submitted.revision,reason:'Reviewed the selected engagement'},'reviewer');
  }
  for(const id of [...cycle(A).assessmentIds,...original])await approve(id);
  assert.equal((await action(B,'submit',{},'analyst',409)).code,'ASSESSMENTS_NOT_APPROVED');
  assert.ok((await call('/api/reporting?workflow=vendor-monitoring')).rows.every(row=>row.key==='vendor-monitoring'));
  assert.doesNotMatch(JSON.stringify(await call('/api/reporting?workflow=vendor-monitoring')),/lodging integration|scope-analyst|SYN-SHARED01/);
  const reviewing=await action(A,'submit');
  assert.equal(cycle(reviewing).assessmentSnapshot.length,2);
  assert.ok(cycle(reviewing).assessmentSnapshot.every(a=>a.engagementId===A.id&&a.assessmentCycleId===cycle(A).assessmentCycleId&&a.decisionByAccount==='scope-reviewer'));
  assert.equal((await action(reviewing,'approve',{note:'Wrong role'},'analyst',403)).code,'INDEPENDENT_REVIEW_REQUIRED');
  const approved=await action(reviewing,'approve',{note:'Approved selected lodging cycle.'},'reviewer');
  const frozen=structuredClone(cycle(approved));
  const renewed=await action(approved,'renew',{note:'Fictional lodging renewal'});
  assert.equal(renewed.id,A.id);assert.equal(cycle(renewed).number,2);
  assert.notEqual(cycle(renewed).assessmentCycleId,cycle(A).assessmentCycleId);
  assert.ok(cycle(renewed).assessmentIds.every(id=>!frozen.assessmentIds.includes(id)));
  assert.deepEqual(renewed.cycles[0],frozen);
  assert.deepEqual(get(titleB),B);
  assert.equal((await call('/api/reporting?workflow=vendor-monitoring')).counts.total,3);
  const handoff=(await write('/api/handoff/'+intake.handoff[0].id+'/send',{})).handoff[0];
  assert.deepEqual(handoff.request.assessments.map(x=>x.id).sort(),original);
  await stop();await start();await login();
  const saved=await call(base,{role:'reviewer'});
  assert.deepEqual(saved.cases.find(c=>c.id===A.id),renewed);
  assert.deepEqual(saved.cases.find(c=>c.id===B.id),B);
  assert.deepEqual((await call(base,{role:'beta',workspace:'beta'})).cases,[]);
});
test('named monitoring decisions check stable accounts after a role switch',()=>{
  const state={vendorMonitoring:{revision:3,cases:[{id:'entry',owner:'analyst',ownerAccount:'owner-account',engagement:{title:'Service'},revision:2,status:'review'}]}};
  const change=(op,actor,account)=>monitoring.change(state,['vendor-monitoring','cases','entry',op],actor,
    {expectedRevision:2,note:'Fictional review'},()=>{},()=>{},account);
  assert.throws(()=>change('approve','reviewer','owner-account'),{status:403,code:'INDEPENDENT_REVIEW_REQUIRED'});
  assert.throws(()=>change('evidence','analyst','another-account'),{status:403,code:'OWNER_REQUIRED'});
});

test('Chromium: two named services for one vendor, scoped linked assessments and separate evidence', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:40_000
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'vendor-engagement-browser-'));
  const server=createServer({dataFile:join(dir,'workbench.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const get=route=>fetch(url+route).then(r=>r.json());
  const synthetic=(await get('/api/state')).vendors.find(v=>!v.usesAI&&!v.handlesSensitiveData);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(6500);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    const open=async()=>{
      await page.getByRole('button',{name:'Browse workspace'}).click();
      await page.getByRole('button',{name:'Vendor monitoring',exact:true}).click();
    };
    await open();
    for(const title of [titleA,titleB]){
      await page.getByText('Open named engagement',{exact:true}).click();
      await page.getByLabel('Engagement vendor').selectOption(synthetic.id);
      await page.getByLabel('Engagement name').fill(title);
      await page.getByLabel('Fictional engagement scope').fill('A separately scoped fictional service.');
      await page.getByRole('button',{name:'Create named engagement'}).click();
      await page.getByRole('heading',{name:new RegExp(title+'$')}).waitFor();
    }
    const model=await get(base);
    const A=model.cases.find(c=>c.engagement.title===titleA);
    const B=model.cases.find(c=>c.engagement.title===titleB);
    const card=id=>page.locator('#work-record-'+id);
    await card(A.id).getByText('Record due diligence evidence',{exact:true}).click();
    await card(A.id).getByLabel('Fictional evidence reference such as SYN-VENDOR01').fill('SYN-LODGE01');
    await card(A.id).getByLabel('Fictional evidence note').fill('Lodging evidence isolated to this engagement.');
    await card(A.id).getByRole('button',{name:'Record evidence',exact:true}).click();
    await card(A.id).getByText('Cycle and evidence history').click();
    await card(A.id).getByText(/SYN-LODGE01: Lodging evidence/).waitFor();
    assert.equal(await card(B.id).getByText(/SYN-LODGE01/).count(),0);
    const snapshotURL=url+'/api/state';
    await page.evaluate(()=>{
      const initialRead=window.read;
      window.vendorSnapshotDispatched=false;
      window.read=function(path,...args){
        const pending=initialRead(path,...args);
        if(path==='/api/state')pending.then(()=>queueMicrotask(()=>queueMicrotask(()=>{window.vendorSnapshotDispatched=true})));
        return pending;
      };
    });
    let release;
    const held=new Promise(resolve=>{release=resolve});
    await page.route(snapshotURL,async route=>{await held;await route.continue()},{times:1});
    const start=page.waitForRequest(snapshotURL);
    await card(A.id).getByRole('button',{name:'Open linked assessments'}).click();
    await start;
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:'Home',exact:true}).click();
    await page.locator('#home-view').waitFor();
    release();
    await page.waitForFunction(()=>window.vendorSnapshotDispatched);
    assert.equal(await page.locator('#home-view').isVisible(),true,'a late assessment snapshot must not override a newer navigation');
    await open();
    await card(A.id).getByRole('button',{name:'Open linked assessments'}).click();
    await page.getByRole('heading',{name:titleA,exact:true}).waitFor();
    const a=A.assessmentStatus[0].id,b=B.assessmentStatus[0].id;
    await card(a).waitFor();
    assert.equal(await card(b).count(),0);
    assert.equal(await page.locator('#assessment-view .assessment').count(),1);
    await card(a).getByLabel('Summary').fill('Fictional intake summary');
    await card(a).getByLabel('Safeguards').fill('Fictional intake safeguards');
    await card(a).getByLabel('Will project data be shared outside your organization?').selectOption('No');
    await card(a).getByRole('button',{name:'Submit for review'}).click();
    await card(a).getByText('in review',{exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await card(a).getByRole('button',{name:'Approve assessment'}).click();
    await card(a).getByText('approved',{exact:true}).waitFor();
    await open();
    await card(A.id).getByText(/privacy: approved/).waitFor();
    await card(B.id).getByText(/privacy: draft/).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
