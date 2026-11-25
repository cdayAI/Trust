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
const {model}=require('../my-work');
const auth={analyst:'sample-owner',reviewer:'sample-primary',limited:'sample-document-only',operator:'sample-case'};
const audit='/api/audit-management',risk='/api/risk-controls',taskUrl=key=>'/api/my-work/tasks/'+key;
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'corrective-my-work-'));
  const codes=Object.fromEntries(Object.keys(auth).map(key=>[key,randomBytes(32).toString('base64url')]));
  const roles={analyst:'analyst',reviewer:'reviewer',limited:'reviewer',operator:'case-operator'};
  const isolated={root:join(dir,'workspaces'),enableIdentityAdmin:true,
    workspaces:[{id:'north',label:'Synthetic North'},{id:'south',label:'Synthetic South'}],
    documentReviewSeats:[{workspace:'north',account:auth.limited}],
    accounts:Object.entries(auth).map(([key,id])=>({id,codeHash:codeHash(codes[key]),memberships:key==='limited'?{north:roles[key]}:{north:roles[key],south:roles[key]}}))};
  const server=createServer({isolated,sqliteFile:join(dir,'workbench.sqlite')}).listen(0,'127.0.0.1');
  await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const cookies={};
  async function request(route,{role,body,expected=200,workspace='north',spoof}={}){
    const query=workspace?'?workspace='+workspace:'';
    const cookie=cookies[role];
    const response=await fetch(url+route+query,{method:body===undefined?'GET':'POST',headers:{
      ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(spoof?{'X-Demo-Actor':spoof}:{})
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,expected,route+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  for(const role of Object.keys(auth))cookies[role]=(await request('/api/session/login',{workspace:null,body:{account:auth[role],code:codes[role],workspace:'north'}})).cookie;
  cookies.south=(await request('/api/session/login',{workspace:null,body:{account:auth.analyst,code:codes.analyst,workspace:'south'}})).cookie;
  const post=async(route,body,role='analyst')=>(await request(route,{body,role})).data;
  const read=async(route,role='analyst')=>(await request(route,{role})).data;
  async function plan(){
    const controls=await post(risk+'/controls',{expectedRevision:0,title:'Private fictional control title',intent:'Private control objective'});
    const control=controls.controls[0];
    let book=await post(audit+'/plans',{controlIds:[control.id],title:'Private fictional audit title',objective:'Private audit objective',scope:'Private audit scope'});
    const auditId=book.plans[0].id,path=audit+'/plans/'+auditId;
    book=await post(path+'/begin',{expectedRevision:book.plans[0].revision});
    book=await post(path+'/assess',{expectedRevision:book.plans[0].revision,controlId:control.id,outcome:'exception',
      evidenceReference:'SYN-ORIGINAL',observation:'Private finding observation',severity:'high',correctiveAction:'Private original proposal'});
    const finding=book.plans[0].assessments[0].finding;
    book=await post(path+'/submit',{expectedRevision:book.plans[0].revision});
    await post(path+'/finalize',{expectedRevision:book.plans[0].revision,note:'Private audit review'},'reviewer');
    book=await post(audit+'/remediations',{findingId:finding.id,action:'Private corrective action',dueDate:'2180-03-31'});
    let row=book.remediation[auditId][0].action;
    const remediation=audit+'/remediations/'+row.id;
    async function action(step,body,role='analyst'){
      const view=await post(remediation+'/'+step,{expectedRevision:row.revision,...body},role);
      row=view.remediation[auditId][0].action;return row;
    }
    async function retest(outcome,no,{decide=true}={}){
      const expectedRevision=(await read(risk)).revision;
      const next=await post(risk+'/tests',{expectedRevision,controlId:control.id,outcome,evidenceReference:'SYN-FOLLOW'+no,note:'Private retest evidence'});
      const test=next.tests.at(-1);
      if(decide)await post(risk+'/tests/'+test.id+'/accept',{expectedRevision:next.revision,note:'Private retest approval'},'reviewer');
      return test;
    }
    return {row,control,auditId,action,retest};
  }
  return {url,codes,plan,request,post,read};
}
test('My Work assigns exact owner and independent reviewer, rotates stale links, closes and reopens without adding general queue actions',async t=>{
  const f=await setup(t),job=await f.plan();
  const current=async role=>(await f.read('/api/my-work',role)).tasks.filter(task=>task.recordLabel==='Audit corrective action');
  const unavailable=(key,role='analyst')=>f.request(taskUrl(key),{role,expected:404});
  const expect=async(role,label)=>{
    const rows=await current(role);assert.equal(rows.length,1);
    const [row]=rows;
    assert.equal(row.actionLabel,label);
    assert.equal(row.timing,'upcoming');assert.equal(row.dueDate,'2180-03-31');
    assert.match(row.key,/^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(row),/private|SYN-FOLLOW|sample-owner|sample-primary|findingId|recordId/i);
    assert.deepEqual((await f.read(taskUrl(row.key),role)).destination,{view:'audit-management',recordId:job.row.id});
    return row.key;
  };
  const first=await expect('analyst','Prepare corrective retest');
  assert.deepEqual(await current('reviewer'),[]);
  assert.deepEqual(await current('operator'),[]);
  await unavailable(first,'reviewer');await unavailable(first,'operator');
  await f.request('/api/my-work',{role:'limited',expected:403,spoof:'reviewer'});
  await f.request(taskUrl(first),{role:'limited',expected:403});
  await f.request(taskUrl(first),{role:'south',workspace:'south',expected:404});
  assert.doesNotMatch(JSON.stringify(await f.read('/api/work-queue')),/Audit corrective action|Private corrective action/);
  const pass=await job.retest('pass','01');
  const ready=await expect('analyst','Submit corrective retest');
  assert.notEqual(ready,first);
  await unavailable(first);
  await job.action('submit',{testId:pass.id,result:'Private submitted result'});
  await unavailable(ready);
  assert.deepEqual(await current('analyst'),[]);
  const review=await expect('reviewer','Review corrective closure independently');
  await unavailable(review);
  await f.request(taskUrl(review),{role:'limited',expected:403});
  const better=await job.retest('pass','02');
  const staleEvidence=await expect('reviewer','Return superseded corrective evidence');
  await unavailable(review,'reviewer');
  await job.action('return',{note:'Private return'},'reviewer');
  await unavailable(staleEvidence,'reviewer');
  const readyAgain=await expect('analyst','Submit corrective retest');
  assert.notEqual(readyAgain,ready);
  await job.action('submit',{testId:better.id,result:'Private resubmission'});
  const freshReview=await expect('reviewer','Review corrective closure independently');
  assert.notEqual(freshReview,review);
  await job.action('close',{note:'Private approval'},'reviewer');
  await unavailable(freshReview,'reviewer');
  assert.deepEqual(await current('reviewer'),[]);assert.deepEqual(await current('analyst'),[]);
  await job.retest('fail','03');
  await job.action('reopen',{note:'Private regression note'},'reviewer');
  const reopened=await expect('analyst','Prepare corrective retest');
  assert.notEqual(reopened,first);await unavailable(first);
  assert.deepEqual(await current('reviewer'),[]);
});

test('a replacement analyst, conflicted reviewer and audit-disabled role cannot receive corrective work from the projection',()=>{
  const finding={id:'finding-1',severity:'high',correctiveAction:'Private action'};
  const state={actors:[{id:'analyst'},{id:'reviewer'}],projects:[],vendors:[],assessments:[],audit:[],
    auditManagement:{plans:[{id:'audit-1',title:'Private audit title',status:'finalized',final:{sha256:'hash',
      result:{reviewHistory:[{at:'2025-01-01'}],controls:[{control:{id:'control-1'},assessment:{finding}}]}}}]},
    auditRemediation:[{id:'corrective-1',finding:{id:finding.id,planId:'audit-1',controlId:'control-1'},owner:'author-account',
      status:'open',revision:1,dueDate:'2027-01-01',proofAfter:'2026-01-01',attempts:[]}]};
  const context={space:{id:'north'},actor:'analyst',account:'author-account'};
  const run=(session,views=['audit-management'])=>model(state,session,views,new URLSearchParams(),undefined,'2027-02-01').tasks;
  assert.equal(run(context)[0].timing,'overdue');
  assert.deepEqual(run({...context,account:'replacement-account'}),[]);
  assert.deepEqual(run(context,[]),[]);
  state.auditRemediation[0].status='in_review';
  state.auditRemediation[0].attempts=[{proof:{id:'retest-1'},decision:null}];
  assert.deepEqual(run({...context,actor:'reviewer'}),[]);
  assert.throws(()=>run({...context,actor:'reviewer',account:'other-reviewer',documentReviewer:true}),{status:404});
  assert.equal(run({...context,actor:'reviewer',account:'other-reviewer'})[0].actionLabel,'Return superseded corrective evidence');
});

test('Chromium: keyboard opens the exact corrective item, closes it, and invalidates its deep link on reload',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:30_000
},async t=>{
  const {chromium}=require('playwright');
  const f=await setup(t),job=await f.plan(),test=await job.retest('pass','01');
  await job.action('submit',{testId:test.id,result:'Private browser corrective result'});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(6500);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(f.url);
    await page.getByLabel('Test account',{exact:true}).fill(auth.reviewer);
    await page.getByLabel('Workspace ID',{exact:true}).fill('north');
    await page.getByLabel('Local access code',{exact:true}).fill(f.codes.reviewer);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:/^My work$/i}).click();
    const link=page.getByRole('link',{name:'Open assigned record: Audit corrective action · Review corrective closure independently'});
    const previous=await link.getAttribute('href');
    await link.focus();
    await page.keyboard.press('Enter');
    const target=page.locator('#audit-management-view #work-record-'+job.row.id);
    await target.locator(':scope:focus').waitFor();
    assert.equal(await target.getAttribute('tabindex'),'-1');
    await target.getByRole('heading',{name:'Private fictional control title · high finding'}).waitFor();
    await target.getByText('Approve corrective closure',{exact:true}).click();
    await target.getByLabel('Corrective closure rationale').fill('Reviewed the exact assigned retest.');
    await target.getByRole('button',{name:'Close corrective action',exact:true}).click();
    await target.getByRole('link',{name:'Download approved closure JSON',exact:true}).waitFor();
    assert.ok(page.url().endsWith(previous));
    await page.reload();
    await page.getByText('This work item is no longer assigned to you.',{exact:true}).waitFor();
    assert.equal(await link.count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
