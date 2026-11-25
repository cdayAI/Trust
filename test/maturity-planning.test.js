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
const maturity=require('../maturity-planning');
const prefix='/api/maturity-planning';
async function listen(server){
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return 'http://127.0.0.1:'+server.address().port;
}

test('SQLite and isolated HTTP: scoped baselines, eligible evidence, reviewer decisions, ranked roadmap, signed history and restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'maturity-plan-sqlite-'));
  const names=['plan-analyst','plan-reviewer','plan-case-handling','beta-analyst'];
  const codes=Object.fromEntries(names.map(name=>[name,randomBytes(32).toString('base64url')]));
  const accounts=names.map((id,i)=>({id,codeHash:codeHash(codes[id]),memberships:i===3?{beta:'analyst'}:{alpha:['analyst','reviewer','case-operator'][i]}}));
  const isolated={root:join(root,'workspaces'),accounts,workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}]};
  const sqliteFile=join(root,'trust.sqlite');
  let server,url;
  async function start(){server=createServer({isolated,sqliteFile});url=await listen(server)}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  async function request(route,expected,{body,cookie,actor,workspace}={}){
    if(workspace)route+='?workspace='+workspace;
    const response=await fetch(url+route,{
      method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:url}),...(cookie?{Cookie:cookie}:{}),...(actor?{'X-Demo-Actor':actor}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=await response.json();
    assert.equal(response.status,expected,route+': '+JSON.stringify(data));
    return {data,response,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(account,workspace='alpha'){return (await request('/api/session/login',200,{body:{account,workspace,code:codes[account]}})).cookie}
  const analyst=await login(names[0]),reviewer=await login(names[1]),operator=await login(names[2]),beta=await login(names[3],'beta');
  const read=(route=prefix,expected=200,cookie=reviewer,workspace='alpha')=>request(route,expected,{cookie,workspace});
  const write=(route,body,expected=200,cookie=analyst,workspace='alpha')=>request(route,expected,{body,cookie,workspace});

  await request(prefix,401,{workspace:'alpha'});
  await read(prefix,403,operator);
  await read(prefix,403,beta,'alpha');
  const emptyAlpha=(await read()).data;
  assert.deepEqual(emptyAlpha.plans,[]);
  const docs='/api/governance-documents';
  const draft=(await write(docs+'/records',{expectedRevision:0,kind:'policy',title:'Fictional privacy operations',content:'Internal fictional text excluded from planning projections',links:[]})).data;
  const doc=draft.documents.at(-1),policyVersion=doc.revisions[0],vPath=docs+'/records/'+doc.id+'/revisions/'+policyVersion.id;
  assert.deepEqual((await read()).data.evidenceOptions,[]);

  const create={title:'Synthetic operating maturity',scope:'Fictional alpha program',capabilityIds:['request-operations','incident-response','policy-governance'],targetDate:'2028-12-31'};
  assert.equal((await write(prefix+'/plans',{...create,targetDate:'2027-02-29'},422)).data.code,'INVALID_DATE');
  assert.equal((await write(prefix+'/plans',{...create,capabilityIds:['incident-response','incident-response']},422)).data.code,'INVALID_SCOPE');
  await write(prefix+'/plans',create,403,reviewer);
  let plan=(await write(prefix+'/plans',create)).data.plans[0];
  assert.equal(plan.versions[0].roadmap.baseline,null);
  assert.equal(plan.createdBy,names[0]);
  const route=prefix+'/plans/'+plan.id;
  const report=route+'/versions/1/report';
  const advance=async(op,payload={},expected=200,cookie=analyst)=>{
    const result=(await write(route+'/'+op,{expectedRevision:plan.revision,...payload},expected,cookie)).data;
    if(expected===200)plan=result.plans[0];
    return result;
  };
  await read(report,409);
  await advance('submit',{},422);
  const first={capability:'request-operations',baseline:1,target:4,evidenceType:'policy',evidenceReference:policyVersion.id,rationale:'Fictional request policy is documented.',
    action:'Sample request handling and measure timeliness.',dueDate:'2028-10-01'};
  assert.equal((await advance('assess',first,422)).code,'INVALID_EVIDENCE');
  await write(vPath+'/submit',{expectedRevision:1});
  await write(vPath+'/publish',{expectedRevision:2,note:'Fictional independent policy review'},200,reviewer);
  assert.equal((await read()).data.evidenceOptions[0].id,policyVersion.id);
  assert.equal((await advance('assess',{...first,capability:'inventory-governance'},422)).code,'CAPABILITY_OUTSIDE_SCOPE');
  assert.equal((await advance('assess',{...first,target:0},422)).code,'INVALID_TARGET');
  assert.equal((await advance('assess',{...first,baseline:1.5},422)).code,'INVALID_LEVEL');
  assert.equal((await advance('assess',{...first,dueDate:'2029-01-01'},422)).code,'AFTER_PLAN_TARGET');
  const betaPlan=(await write(prefix+'/plans',create,200,beta,'beta')).data.plans[0];
  assert.equal((await write(prefix+'/plans/'+betaPlan.id+'/assess',{...first,expectedRevision:betaPlan.revision},422,beta,'beta')).data.code,'INVALID_EVIDENCE');
  await advance('assess',first);
  const incident={capability:'incident-response',baseline:2,target:3,evidenceType:'synthetic',evidenceReference:'SYN-TABLETOP-01',
    rationale:'Fictional tabletop documented',action:'Measure closure time.',dueDate:'2028-07-15'};
  await advance('assess',incident);
  const policy={capability:'policy-governance',baseline:3,target:3,evidenceType:'policy',evidenceReference:policyVersion.id,rationale:'Synthetic attestations already measured.'};
  await advance('assess',policy);
  let model=plan.versions[0].roadmap;
  assert.equal(model.baseline,1.8);
  assert.equal(model.target,3.4);
  assert.deepEqual(model.gaps.map(r=>[r.capability,r.priority,r.priorityScore]),[['request-operations','critical',12],['incident-response','medium',4]]);
  await advance('submit');
  const before=structuredClone(plan);
  assert.equal((await request(route+'/approve',403,{workspace:'alpha',cookie:analyst,actor:'reviewer',body:{expectedRevision:plan.revision,note:'No self-review'}})).data.code,'INDEPENDENT_REVIEW_REQUIRED');
  assert.equal((await advance('approve',{note:'Not yet accepted'},422,reviewer)).code,'EVIDENCE_NOT_ACCEPTED');
  assert.deepEqual((await read()).data.plans[0],before);
  const decide=async(capability,decision,expected=200)=>{
    const scoreId=plan.versions[0].scores.findLast(x=>x.capability===capability).id;
    return advance('decide',{capability,scoreId,decision,note:'Synthetic evidence assessment.'},expected,reviewer);
  };
  const originalIncident=plan.versions[0].scores.find(r=>r.capability==='incident-response').id;
  await decide('request-operations','accept');
  await decide('incident-response','reject');
  await decide('incident-response','accept',409);
  await decide('policy-governance','accept');
  await advance('approve',{note:'Rejected evidence is not accepted'},422,reviewer);
  await advance('return',{note:'Run the sample again.'},200,reviewer);
  await advance('assess',{...incident,evidenceReference:'SYN-TABLETOP-02',baseline:3,target:4});
  assert.equal(plan.versions[0].scores.at(-1).supersedes,originalIncident);
  await advance('submit');
  await advance('decide',{capability:'incident-response',scoreId:originalIncident,decision:'accept',note:'Stale evidence'},409,reviewer);
  await decide('incident-response','accept');
  await advance('approve',{expectedRevision:plan.revision-1,note:'Stale plan revision'},409,reviewer);
  await advance('approve',{note:'Approved fictional baseline and roadmap.'},200,reviewer);
  assert.equal(plan.versions[0].status,'approved');

  const download=await read(report);
  assert.equal(download.response.headers.get('content-disposition'),'attachment; filename="mvw-trust-plan-v1.json"');
  assert.equal(download.data.result.roadmap.baseline,2.2);
  assert.equal(download.data.result.roadmap.target,3.8);
  assert.equal(download.data.result.reviewHistory.at(-1).reviewer,names[1]);
  assert.equal(download.data.result.evidenceHistory.length,4);
  assert.equal(download.data.result.assessmentHistory.length,4);
  assert.equal(download.data.sha256,createHash('sha256').update(JSON.stringify(download.data.result)).digest('hex'));
  assert.doesNotMatch(JSON.stringify(download.data),/Internal fictional text excluded/);
  await read(report,404,beta,'beta');
  await advance('assess',first,409);
  await advance('revise',{targetDate:'2029-12-31'});
  assert.equal(plan.versions[1].status,'draft');
  assert.deepEqual(plan.versions[1].scores,[]);
  await read(route+'/versions/2/report',409);
  assert.deepEqual((await read(report)).data,download.data);
  const audit=(await read('/api/audit/export')).data.audit;
  assert.equal(audit.find(x=>x.action==='maturity-planning.approve').account,names[1]);
  await stop();await start();
  const fresh=await login(names[1]);
  assert.deepEqual((await read(report,200,fresh)).data,download.data);
  assert.equal((await read(prefix,200,fresh)).data.plans[0].versions[1].status,'draft');
});

test('a reviewer identity recorded as contributor cannot approve or decide their own evidence',()=>{
  const state={};
  const events=[];
  const event=(...args)=>events.push(args);
  const change=(path,actor,body,account)=>maturity.change(state,['maturity-planning','plans',...path],actor,body,event,null,account);
  change([],'analyst',{title:'Synthetic',scope:'Test',targetDate:'2028-01-01',capabilityIds:['incident-response']},'same-account');
  const p=state.maturityPlanning.plans[0];
  change([p.id,'assess'],'analyst',{expectedRevision:1,capability:'incident-response',baseline:0,target:0,evidenceType:'synthetic',
    evidenceReference:'SYN-BASELINE',rationale:'Synthetic report'},'same-account');
  change([p.id,'submit'],'analyst',{expectedRevision:2},'same-account');
  assert.throws(()=>change([p.id,'approve'],'reviewer',{expectedRevision:3,note:'Approving own plan'},'same-account'),
    {status:403,code:'INDEPENDENT_REVIEW_REQUIRED'});
  assert.throws(()=>change([p.id,'decide'],'reviewer',{expectedRevision:3,scoreId:p.versions[0].scores[0].id,capability:'incident-response',decision:'accept',note:'Reused account'},'same-account'),
    {status:403,code:'INDEPENDENT_REVIEW_REQUIRED'});
  assert.equal(p.versions[0].decisions.length,0);
});

test('Chromium: draft a scoped plan, enter a roadmap gap, review evidence, and download the signed version',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout:30_000
},async t=>{
  const {chromium}=require('playwright');
  const root=await mkdtemp(join(tmpdir(),'maturity-browser-'));
  const server=createServer({dataFile:join(root,'state.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});
    page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:'Maturity planning',exact:true}).click();
    await page.getByText('New maturity plan',{exact:true}).click();
    await page.getByLabel('Maturity plan title').fill('Synthetic team maturity');
    await page.getByLabel('Fictional planning scope').fill('One fictional incident program');
    await page.getByLabel('Version target date (UTC)').fill('2029-10-31');
    await page.getByRole('checkbox',{name:/Incident response/}).check();
    await page.getByRole('button',{name:'Create maturity plan'}).click();
    await page.getByRole('heading',{name:'Synthetic team maturity'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Submit maturity plan'}).isDisabled(),true);
    await page.getByText('Score capability',{exact:true}).click();
    await page.getByLabel('Baseline maturity level').selectOption('1');
    await page.getByLabel('Target maturity level').selectOption('4');
    await page.getByLabel('Evidence source type').selectOption('synthetic');
    await page.getByLabel('Synthetic evidence reference').fill('SYN-INCIDENT-2029');
    await page.getByLabel('Fictional scoring rationale').fill('Fictional tabletop evidence is on file.');
    await page.getByLabel('Roadmap action',{exact:true}).fill('Rehearse escalation and check evidence completeness.');
    await page.getByLabel('Roadmap action due date (UTC)').fill('2029-08-31');
    await page.getByRole('button',{name:'Save capability score'}).click();
    await page.getByText('critical priority',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Submit maturity plan'}).click();
    await page.getByText('in review',{exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await page.getByText('Review capability evidence',{exact:true}).click();
    await page.getByLabel('Evidence decision',{exact:true}).selectOption('accept');
    await page.getByLabel('Evidence decision rationale').fill('Synthetic scenario supports the stated baseline.');
    await page.getByRole('button',{name:'Record evidence decision'}).click();
    await page.getByLabel('Independent signoff rationale').fill('Scope and roadmap reviewed independently.');
    await page.getByRole('button',{name:'Sign version'}).click();
    const downloadPromise=page.waitForEvent('download');
    await page.getByRole('link',{name:'Download signed version 1'}).click();
    const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),'mvw-trust-plan-v1.json');
    let payload='';
    for await(const chunk of await download.createReadStream())payload+=chunk.toString();
    const report=JSON.parse(payload);
    assert.equal(report.result.roadmap.gaps[0].priorityScore,12);
    assert.equal(report.result.reviewHistory.at(-1).decision,'approved');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
