'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const enabled={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:45_000};
const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
const see=(scope,message)=>scope.getByText(message,{exact:true}).waitFor();
const gone=(scope,message)=>scope.getByText(message,{exact:true}).waitFor({state:'hidden'});
const entry=(page,pane,title)=>pane.locator('article').filter({has:h(page,title)});
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

async function fixture(t){
  const {chromium}=require('playwright'),root=await mkdtemp(join(tmpdir(),'mvw-edge-browser-'));
  const codes=Object.fromEntries(['analyst','reviewer','case-operator'].map(r=>[r,randomBytes(32).toString('base64url')]));
  const server=createServer({isolated:{root,workspaces:[{id:'alpha',label:'Fictional Alpha'}],
    accounts:Object.keys(codes).map(role=>({id:'test-'+role,codeHash:codeHash(codes[role]),memberships:{alpha:role}}))
  }}).listen(0,'127.0.0.1');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const errors=[],external=[],actions=[],availability=[];
  async function login(role){
    const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(6500);
    await p.route('**/*',r=>{
      if(new URL(r.request().url()).origin===url)return r.continue();
      external.push(r.request().url());return r.abort();
    });
    await p.goto(url);
    await p.getByLabel('Test account').fill('test-'+role);
    await p.getByLabel('Workspace ID').fill('alpha');
    await p.getByLabel('Local access code').fill(codes[role]);
    await b(p,'Sign in').click();
    await see(p,'test-'+role+' · '+role);
    return p;
  }
  async function click(scope,label,outcome,effect){
    await b(scope,label).click();await effect();actions.push({control:label,outcome});
  }
  async function fill(scope,label,value){
    const field=scope.getByLabel(label);
    await field.fill(value);assert.equal(await field.inputValue(),value);
    actions.push({control:label,outcome:'Filled synthetic value'});
  }
  async function select(scope,label,value){
    const field=scope.getByLabel(label);
    await field.selectOption(value);
    if(typeof value==='string')assert.equal(await field.inputValue(),value);
    else assert.equal(await field.locator('option:checked').innerText(),value.label);
    actions.push({control:label,outcome:'Selected '+(value.label||value)});
  }
  function details(scope,label){
    const p=typeof scope.page==='function'?scope.page():scope;
    const summary=p.locator('summary').filter({hasText:new RegExp('^'+escape(label)+'$')});
    return scope.locator('details').filter({has:summary});
  }
  async function reveal(scope,label){
    const disclosure=details(scope,label);
    await disclosure.locator(':scope > summary').click();
    assert.equal(await disclosure.evaluate(e=>e.open),true);
    actions.push({control:label,outcome:'Expanded disclosure'});
    return disclosure;
  }
  async function unavailable(scope,label){
    assert.equal(await details(scope,label).count(),0);
    availability.push({control:label,outcome:'Not exposed in this state'});
  }
  async function reloadTab(p,name,wait){
    await p.reload();await click(p,name,'Opened a fresh workspace view',wait);
  }
  async function download(p,name,filename){
    const [file]=await Promise.all([p.waitForEvent('download'),p.getByRole('link',{name,exact:true}).click()]);
    assert.equal(file.suggestedFilename(),filename);
    const parts=[];for await(const part of await file.createReadStream())parts.push(part);
    actions.push({control:name,outcome:'Downloaded real JSON for assertions'});
    return JSON.parse(Buffer.concat(parts).toString());
  }
  return {login,click,fill,select,details,reveal,unavailable,reloadTab,download,finish(){
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    t.diagnostic(JSON.stringify({activated:actions.length,observedOnly:availability.length,actions,availability}));
  }};
}

test('browser risk controls: independent evidence and link decisions govern residual scores through rejection, rescore and unlink',enabled,async t=>{
  const f=await fixture(t),a=await f.login('analyst'),r=await f.login('reviewer');
  const aa=a.locator('#risk-controls-view'),rr=r.locator('#risk-controls-view');
  const risk='Fictional access risk',control='Fictional independent control';
  const ar=entry(a,aa,risk),rrisk=entry(r,rr,risk),ac=entry(a,aa,control),rc=entry(r,rr,control);
  const score=(scope,num)=>scope.getByText(new RegExp('^Residual score: '+num+' \\(')).waitFor();
  await f.click(a,'Risk and controls','Opened real risk register',()=>h(aa,'Risk register').waitFor());
  const addRisk=await f.reveal(aa,'Add risk');
  await f.fill(addRisk,'Fictional risk title',risk);
  await f.fill(addRisk,'Fictional risk scenario','Synthetic users could be assigned a broader policy than intended.');
  await f.fill(addRisk,'Likelihood','5');await f.fill(addRisk,'Impact','4');
  await f.click(addRisk,'Add risk','Risk begins with unreduced score 20',()=>score(ar,20));
  const addControl=await f.reveal(aa,'Add control');
  await f.fill(addControl,'Fictional control title',control);
  await f.fill(addControl,'Fictional control objective','Fictional reviewers confirm the exact approved scope.');
  await f.click(addControl,'Add control','Added mitigation candidate',()=>h(ac,control).waitFor());
  const link=await f.reveal(ar,'Link mitigation');
  await f.select(link,'Mitigating control',{label:control});
  await f.fill(link,'Likelihood reduction','2');await f.fill(link,'Impact reduction','1');
  await f.fill(link,'Fictional mitigation rationale','Synthetic scope checks can reduce impact.');
  const linkNote='Synthetic scope checks can reduce impact.';
  await f.click(link,'Link mitigation','Unverified link has no residual effect',async()=>{
    await see(ar,control+': Mitigation link needs independent review · '+linkNote);
    await score(ar,20);
  });
  await f.unavailable(ar,'Verify mitigation link');
  async function record(id,outcome){
    const form=await f.reveal(ac,'Record test');
    await f.select(form,'Test outcome',outcome);
    await f.fill(form,'Fictional evidence ID',id);
    await f.fill(form,'Fictional test note','Synthetic observed test.');
    await f.click(form,'Record test','Latest evidence pending independent review',()=>see(ac,'Current: '+outcome+' · pending · '+id+' · Synthetic observed test.'));
  }
  async function decision(disclosure,note,scope,witness){
    const pane=await f.reveal(scope,disclosure);
    await f.fill(pane,'Fictional test review note',note);
    await f.click(pane,disclosure,note,witness);
  }
  await record('SYN-VERIFY01','pass');
  await f.unavailable(ac,'Accept test evidence');
  await f.reloadTab(r,'Risk and controls',()=>h(rc,control).waitFor());
  await decision('Accept test evidence','Pass accepted; verification still required.',rc,async()=>{await see(rc,'Current: pass · accepted · SYN-VERIFY01 · Synthetic observed test.');await score(rrisk,20);});
  const verify=await f.reveal(rrisk,'Verify mitigation link');
  await f.fill(verify,'Fictional mitigation review note','Independently confirmed synthetic mitigation.');
  await f.click(verify,'Verify mitigation link','Verified mitigation and accepted pass reduce 20 to 9',()=>score(rrisk,9));
  await f.reloadTab(a,'Risk and controls',()=>score(ar,9));
  await record('SYN-VERIFY02','pass');
  await score(ar,20);
  await f.reloadTab(r,'Risk and controls',()=>see(rc,'Current: pass · pending · SYN-VERIFY02 · Synthetic observed test.'));
  await decision('Reject test evidence','Current synthetic evidence was insufficient.',rc,async()=>{
    await see(rc,'Current: pass · rejected · SYN-VERIFY02 · Synthetic observed test.');
    await score(rrisk,20);
  });
  await see(rc,'Superseded: pass · accepted · SYN-VERIFY01 · Synthetic observed test.');
  await f.reloadTab(a,'Risk and controls',()=>score(ar,20));
  const rescore=await f.reveal(ar,'Re-score risk');
  await f.fill(rescore,'Likelihood','4');await f.fill(rescore,'Impact','4');
  await f.fill(rescore,'Fictional re-score rationale','Changed fictional intake assumptions.');
  await f.click(rescore,'Save scores','Base score updated and no rejected evidence applied',()=>score(ar,16));
  const unlink=await f.reveal(ar,'Unlink mitigation');
  await f.fill(unlink,'Fictional unlink rationale','No active synthetic mitigation remains.');
  await f.click(unlink,'Unlink mitigation','Unlinked mitigation remains as history without reduction',()=>see(ar,control+': Unlinked · '+linkNote));
  await f.unavailable(ar,'Unlink mitigation');
  await f.reloadTab(r,'Risk and controls',()=>score(rrisk,16));
  const file=await f.download(r,'Export risk and controls JSON','privacy-workbench-risk-controls.json');
  const saved=file.program.risks.find(x=>x.title===risk);
  assert.equal(saved.residual.value,16);
  assert.ok(saved.links[0].archivedAt);
  assert.deepEqual(file.program.tests.map(x=>x.reviewStatus),['accepted','rejected']);
  f.finish();
});

test('browser rights: stale reassignment recovery, independent failed verification, correct owner closes without disclosure',enabled,async t=>{
  const f=await fixture(t),a=await f.login('analyst'),old=await f.login('analyst'),r=await f.login('reviewer'),op=await f.login('case-operator');
  const pane=p=>p.locator('#rights-view');
  const row=p=>entry(p,pane(p),'Deletion case');
  await f.click(a,'Privacy rights','Opened actual rights intake',()=>b(pane(a),'Open rights case').waitFor());
  await f.select(pane(a),'Request type','deletion');
  await f.select(pane(a),'Assigned owner','analyst');
  await f.fill(pane(a),'Fictional intake note','Fictional request for a no-disclosure outcome.');
  await f.click(pane(a),'Open rights case','New case exists with pending identity',()=>see(row(a),'Identity: pending'));
  await f.click(old,'Privacy rights','Separate old tab sees old assignment revision',()=>see(row(old),'Identity: pending'));
  const oldAssign=await f.reveal(row(old),'Reassign');
  await f.select(oldAssign,'New owner','case-operator');
  await f.fill(oldAssign,'Fictional action note','This stale action must not overwrite the later transfer.');
  await f.click(op,'Privacy rights','Case operator cannot see work assigned to analyst',()=>see(pane(op),'No rights cases yet.'));
  const assign=await f.reveal(row(a),'Reassign');
  await f.select(assign,'New owner','case-operator');
  const assignmentNote='Transfer this fictional request to the case handling seat.';
  await f.fill(assign,'Fictional action note',assignmentNote);
  await f.click(assign,'Reassign','Analyst assigns a different owner',()=>row(a).getByText(/^Assigned owner: Case Operator/).waitFor());
  await f.click(oldAssign,'Reassign','Stale edit refused and reload offered',()=>b(old,'Reload cases').waitFor());
  await f.click(old,'Reload cases','Old tab sees the committed owner, not stale form values',()=>row(old).getByText(/^Assigned owner: Case Operator/).waitFor());
  await f.reloadTab(op,'Privacy rights',()=>see(row(op),'Identity: pending'));
  await f.unavailable(row(op),'Mark identity not verified');
  await f.unavailable(row(op),'Close without disclosure');
  await f.click(r,'Privacy rights','Independent reviewer sees pending case',()=>see(row(r),'Identity: pending'));
  const verify=await f.reveal(row(r),'Mark identity not verified');
  await f.fill(verify,'Fictional action note','Fictional identity evidence was insufficient.');
  await f.click(verify,'Mark identity not verified','Independent reviewer records failed verification',()=>see(row(r),'Identity: not verified'));
  await f.unavailable(row(r),'Close without disclosure');
  await f.reloadTab(op,'Privacy rights',()=>see(row(op),'Identity: not verified'));
  await f.unavailable(row(op),'Begin fulfillment');
  const close=await f.reveal(row(op),'Close without disclosure');
  await f.fill(close,'Fictional action note','No records or information were released.');
  await f.click(close,'Close without disclosure','New assigned operator closes without fulfillment',()=>see(row(op),'Closed without disclosure.'));
  await f.reloadTab(op,'Privacy rights',()=>see(row(op),'Closed without disclosure.'));
  const historyLabel=await row(op).locator('summary').filter({hasText:/^Case history \(\d+\)$/}).innerText();
  const history=await f.reveal(row(op),historyLabel);
  await history.getByText(new RegExp(escape(assignmentNote)+'$')).waitFor();
  await history.getByText(/No records or information were released\.$/).waitFor();
  assert.equal(await history.getByText(/Stale action must not overwrite/i).count(),0);
  await f.unavailable(row(op),'Close without disclosure');
  await f.unavailable(row(op),'Document mock fulfillment');
  f.finish();
});
