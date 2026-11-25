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
const controls=require('../risk-controls');
const root='/api/audit-management',rem=root+'/remediations',risk='/api/risk-controls';
async function listen(server){
  server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;
}
async function seed(post){
  const scope=await post(risk+'/controls',{expectedRevision:0,title:'Fictional access control',intent:'Limit synthetic access to the responsible team'});
  const control=scope.controls[0];
  const outside=await post(risk+'/controls',{expectedRevision:scope.revision,title:'Outside control',intent:'Unrelated synthetic control'});
  const other=outside.controls.at(-1);
  let plans=await post(root+'/plans',{controlIds:[control.id],title:'Fictional control assurance',objective:'Exercise evidence and follow-through.',scope:'Synthetic Q1 only.'});
  const planPath=root+'/plans/'+plans.plans[0].id;
  plans=await post(planPath+'/begin',{expectedRevision:plans.plans[0].revision});
  plans=await post(planPath+'/assess',{expectedRevision:plans.plans[0].revision,controlId:control.id,outcome:'exception',
    evidenceReference:'SYN-FAILURE-01',observation:'Fictional review sample did not pass.',severity:'high',correctiveAction:'Add verification and retest.'});
  plans=await post(planPath+'/submit',{expectedRevision:plans.plans[0].revision});
  const finding=plans.plans[0].assessments[0].finding;
  plans=await post(planPath+'/finalize',{expectedRevision:plans.plans[0].revision,note:'Fictional review approved the original finding.'},'reviewer');
  let riskRevision=outside.revision;
  async function retest(controlId,outcome,sequence,{decision='accept'}={}){
    let board=await post(risk+'/tests',{expectedRevision:riskRevision,controlId,outcome,evidenceReference:'SYN-RETEST'+sequence,note:'Fictional retest completed independently.'});
    riskRevision=board.revision;
    const result=board.tests.at(-1);
    if(decision){
      board=await post(risk+'/tests/'+result.id+'/'+decision,{expectedRevision:riskRevision,note:'Synthetic retest decision.'},'reviewer');
      riskRevision=board.revision;
    }
    return result;
  }
  return {control,other,finding,plan:plans.plans[0],planPath,retest};
}
test('isolated SQLite: owner and reviewer close only against latest same-control retest, regression reopens without rewriting history',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'audit-remediation-'));
  const people=[['alpha-analyst','alpha','analyst'],['alpha-reviewer','alpha','reviewer'],
    ['alpha-case','alpha','case-operator'],['beta-analyst','beta','analyst']];
  const codes=Object.fromEntries(people.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(dir,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:people.map(([id,space,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[space]:role}}))};
  let server,url;
  async function start(){server=createServer({isolated,sqliteFile:join(dir,'workbench.sqlite')});url=await listen(server)}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true})});
  await start();
  async function fetchRecord(path,body,cookie,space,expected=200){
    if(space)path+='?workspace='+space;
    const res=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{
      ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await res.json();assert.equal(res.status,expected,path+': '+JSON.stringify(data));return {res,data};
  }
  const cookies={};
  async function login(){
    for(const [account,workspace,role] of people){
      const {res}=await fetchRecord('/api/session/login',{account,workspace,code:codes[account]});
      const key=workspace==='beta'?'beta':role;
      cookies[key]=res.headers.get('set-cookie').split(';')[0];
    }
  }
  await login();
  const post=async(route,body,role='analyst',expected=200,space='alpha')=>(await fetchRecord(route,body,cookies[role],space,expected)).data;
  const read=async(route,role='reviewer',expected=200,space='alpha')=>(await fetchRecord(route,undefined,cookies[role],space,expected)).data;
  await read(root,'case-operator',403);
  const setup=await seed(post);
  const {control,other,finding,plan,planPath,retest}=setup;
  const audit=await read(planPath+'/report');
  const early=await retest(control.id,'pass','01');
  const actions=body=>post(rem,body);
  const change={findingId:finding.id,action:'Remediate through synthetic test.',dueDate:'2190-04-15'};
  assert.equal((await post(rem,{...change,findings:'bogus'},'analyst',422)).code,'REMEDIATION_FIELDS');
  assert.equal((await post(rem,{...change,dueDate:'2190-02-30'},'analyst',422)).code,'REMEDIATION_BAD_DATE');
  assert.equal((await post(rem,{...change,findingId:control.id},'analyst',404)).code,'FINAL_FINDING_REQUIRED');
  assert.equal((await post(rem,change,'beta',404,'beta')).code,'FINAL_FINDING_REQUIRED');
  assert.equal((await post(rem,change,'reviewer',403)).code,'ACCESS_DENIED');
  const model=await actions(change);
  let row=model.remediation[plan.id][0].action;
  assert.equal(row.owner,'alpha-analyst');
  assert.equal(row.finding.auditSha256,audit.sha256);
  assert.equal(row.deadline,'scheduled');
  await post(rem,change,'analyst',409);
  const route=rem+'/'+row.id, exportPath=route+'/report';
  const action=async(op,body,role='analyst',expected=200)=>{
    const result=await post(route+'/'+op,{expectedRevision:row.revision,...body},role,expected);
    if(expected===200)row=result.remediation[plan.id][0].action;
    return result;
  };
  await read(exportPath,'reviewer',409);
  await read(exportPath,'case-operator',403);
  await read(exportPath,'beta',404,'beta');
  await action('plan',{action:'Stale revision',dueDate:'2190-04-15',expectedRevision:99},'analyst',409);
  const result='Fictional termination tests now pass.';
  await action('submit',{testId:early.id,result},'analyst',422);
  const misaligned=await retest(other.id,'pass','02');
  await action('submit',{testId:misaligned.id,result},'analyst',422);
  const pass=await retest(control.id,'pass','03');
  await action('submit',{testId:pass.id,result});
  const intervening=await retest(control.id,'pass','04');
  assert.equal((await action('close',{note:'The old evidence is stale.'},'reviewer',409)).code,'REMEDIATION_EVIDENCE_CHANGED');
  await action('return',{note:'Review the newer test before resubmission.'},'reviewer');
  await action('submit',{testId:intervening.id,result});
  await action('close',{note:'Verified the exact remediation retest.'},'reviewer');
  const closure=await read(exportPath);
  assert.equal(closure.closures[0].result.attempt.proof.id,intervening.id);
  assert.equal(closure.closures[0].result.attempt.decision.reviewer,'alpha-reviewer');
  assert.equal(closure.closures[0].sha256,createHash('sha256').update(JSON.stringify(closure.closures[0].result)).digest('hex'));
  assert.deepEqual(await read(planPath+'/report'),audit);
  await action('reopen',{note:'No accepted regression yet.'},'reviewer',409);
  const failing=await retest(control.id,'fail','05');
  await action('reopen',{note:'The next independently accepted test found regression.'},'reviewer');
  assert.equal(row.reopened[0].failureTestId,failing.id);
  assert.deepEqual(await read(exportPath),closure);
  const restored=await retest(control.id,'pass','06');
  await action('submit',{testId:restored.id,result:'Recorded a stronger fictional control.'});
  await action('close',{note:'Verified follow-up retest.'},'reviewer');
  const final=await read(exportPath);
  assert.equal(final.closures.length,2);
  assert.deepEqual(final.closures[0],closure.closures[0]);
  assert.equal(final.closures[1].result.attempt.number,3);
  assert.equal((await read('/api/state','analyst')).auditRemediation,undefined);
  await stop();await start();await login();
  assert.deepEqual(await read(exportPath),final);
  assert.deepEqual(await read(planPath+'/report'),audit);
});

test('stable account, not selected role, decides control-test review independence',()=>{
  const state={riskControls:{revision:0,risks:[],controls:[{id:'test-control'}],links:[],tests:[]}};
  controls.change(state,['risk-controls','tests'],'analyst',{expectedRevision:0,controlId:'test-control',outcome:'pass',
    evidenceReference:'SYN-CHECK01',note:'Input from author.'},()=>{},null,'same-account');
  const id=state.riskControls.tests[0].id;
  assert.throws(()=>controls.change(state,['risk-controls','tests',id,'accept'],'reviewer',{expectedRevision:1,note:'Cannot review own proof.'},
    ()=>{},null,'same-account'),{status:403,code:'INDEPENDENT_REVIEW_REQUIRED'});
});

test('Chromium mobile moves from audit finding through actual risk retest to independently approved JSON',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:45_000
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'audit-remediation-browser-'));
  const server=createServer({dataFile:join(dir,'workbench.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  await seed(async(route,body,role='analyst')=>{
    const res=await fetch(url+route,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Demo-Actor':role},body:JSON.stringify(body)});
    const data=await res.json();assert.equal(res.status,200,route+': '+JSON.stringify(data));return data;
  });
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});page.setDefaultTimeout(7000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const tab=async(label)=>{
      await page.getByRole('button',{name:'Browse workspace'}).click();
      await page.getByRole('button',{name:label,exact:true}).click();
    };
    await page.goto(url);
    await tab('Audit management');
    await page.getByText('Assign corrective action to me',{exact:true}).click();
    await page.getByLabel('Corrective action',{exact:true}).fill('Add a fictional dual check.');
    await page.getByLabel('Corrective due date (UTC)').fill('2190-04-15');
    await page.getByRole('button',{name:'Create corrective action'}).click();
    await page.getByText(/Owner: analyst/).waitFor();
    await page.getByRole('button',{name:'Open Risk and controls'}).click();
    const control=page.locator('#risk-controls-view article').filter({has:page.getByRole('heading',{name:'Fictional access control'})});
    await control.locator('summary').filter({hasText:/^Record test$/}).click();
    await control.getByLabel('Test outcome').selectOption('pass');
    await control.getByLabel('Fictional evidence ID such as SYN-CHECK01').fill('SYN-RETEST01');
    await control.getByLabel('Fictional test note').fill('Fictional retest met the simulated control requirements.');
    await control.getByRole('button',{name:'Record test',exact:true}).click();
    await control.getByText(/Current: pass · pending/).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    const accept=control.locator('details').filter({has:page.locator('summary').filter({hasText:/^Accept test evidence$/})});
    await accept.locator('summary').click();
    await accept.getByLabel('Fictional test review note').fill('Separate fictional reviewer checked the test.');
    await accept.getByRole('button',{name:'Accept test evidence',exact:true}).click();
    await control.getByText(/Current: pass · accepted/).waitFor();
    await page.getByLabel('Demo identity').selectOption('analyst');
    await tab('Audit management');
    await page.getByText('Submit corrective retest',{exact:true}).click();
    await page.getByLabel('Corrective result').fill('Added the fictional second check and retested.');
    await page.getByRole('button',{name:'Send retest for independent closure'}).click();
    await page.getByText(/Submitted retest: SYN-RETEST01/).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    await page.getByText('Approve corrective closure',{exact:true}).click();
    await page.getByLabel('Corrective closure rationale').fill('Used the independently accepted fictional control retest.');
    await page.getByRole('button',{name:'Close corrective action'}).click();
    const dl=page.waitForEvent('download');await page.getByRole('link',{name:'Download approved closure JSON'}).click();
    const download=await dl;let bytes='';
    for await(const chunk of await download.createReadStream())bytes+=chunk.toString();
    const {closures:[closure]}=JSON.parse(bytes);
    assert.equal(closure.result.attempt.decision.outcome,'closed');
    assert.equal(closure.result.attempt.proof.evidenceReference,'SYN-RETEST01');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});

test('owner is the original signed-in account and cannot close an action after changing to reviewer',()=>{
  const {change}=require('../audit-remediation');
  const state={auditRemediation:[{id:'synthetic-action',owner:'owner-account',status:'in_review',revision:2,attempts:[]}]};
  const action=(op,role,account,body)=>change(state,['audit-management','remediations','synthetic-action',op],role,
    {expectedRevision:2,...body},()=>{},null,account);
  assert.throws(()=>action('close','reviewer','owner-account',{note:'Role switched'}),{status:403,code:'REMEDIATION_INDEPENDENCE_REQUIRED'});
  assert.throws(()=>action('plan','analyst','other-account',{action:'Not my record',dueDate:'2190-04-15'}),{status:403,code:'REMEDIATION_OWNER_REQUIRED'});
});
