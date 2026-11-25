'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const training='/api/training',learn='/api/training-learner',docs='/api/governance-documents/records';
const title='Fictional final-attempt training',policyTitle='Synthetic learner training policy';
const policyText='Fictional policy for the assigned local exercise only.';
const note='Reviewed only for this synthetic rehearsal.';
const firstExhaustion='No attempts remain. Ask the local analyst to reset attempts.';
const finalExhaustion='No attempts remain. The one-time reset has already been used. This assignment cannot be reset again.';
const b=(s,name)=>s.getByRole('button',{name,exact:true});
const h=(s,name)=>s.getByRole('heading',{name,exact:true});
const see=(s,value)=>s.getByText(value,{exact:true}).waitFor();

async function setup(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-training-final-'));
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
  const learner=workspace=>access.learners.find(x=>x.workspace===workspace);
  return {url:live.url,seat,request,login,learner};
}

test('composed Chromium: final training exhaustion agrees with the one-time reset boundary',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:45_000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const a=await f.login('analyst'),r=await f.login('reviewer');
  const send=(path,body,cookie=a)=>f.request(path,{cookie,body}).then(x=>x.data);
  const staff=(path,cookie=a)=>f.request(path,{cookie}).then(x=>x.data);
  const author=f.seat('harbor','analyst');
  const issued=f.learner('harbor'),outsider=f.learner('orchard');
  const initial=await send(docs,{expectedRevision:0,kind:'policy',title:policyTitle,content:policyText,links:[]});
  const document=initial.documents[0],edition=document.revisions[0],ref=docs+'/'+document.id+'/revisions/'+edition.id;
  await send(ref+'/submit',{expectedRevision:1});
  await send(ref+'/publish',{expectedRevision:2,note},r);
  const courseDraft=await send(training+'/create',{title,template:'fictional-policy-practice-v1',document:document.id,
    edition:edition.id,hash:edition.contentHash});
  const course=courseDraft.courses.find(x=>x.title===title);
  const waiting=await send(training+'/submit',{course:course.id,revision:course.revision});
  const published=await send(training+'/publish',{course:course.id,revision:waiting.courses[0].revision,note},r);
  const assigned=await send(training+'/assign',{course:course.id,revision:published.courses[0].revision,learner:issued.alias});
  const assignment=assigned.assignments[0];
  const act=(action,fields={},status=200,seat=issued)=>f.request(learn+'/'+action,{workspace:null,body:{code:seat.code,...fields},status}).then(x=>x.data);
  let active=(await act('start',{assignment:assignment.id,revision:assignment.revision})).lesson;
  async function stageWrong(){
    for(let count=0;count<4;count++){
      active=(await act('complete',{assignment:assignment.id,revision:active.revision,answers:[0,1,0],confirm:true})).lesson;
    }
    assert.equal(active.attemptsRemaining,1);
  }
  await stageWrong();
  const errors=[],external=[];
  async function page(){
    const p=await browser.newPage({viewport:{width:860,height:820},reducedMotion:'reduce'});
    p.setDefaultTimeout(6500);
    p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===f.url)return route.continue();
      external.push(url.origin);return route.abort();
    });
    return p;
  }
  async function openLearner(seat){
    const p=await page();
    await p.goto(f.url+'/training');
    await p.getByLabel('Synthetic learner code',{exact:true}).fill(seat.code);
    await b(p,'View my assignments').press('Enter');
    await h(p,'Assignments').waitFor();
    return p;
  }
  const learner=await openLearner(issued),courseCard=learner.locator('#learner-current');
  async function openAssignment(){
    await b(learner,'Open '+title).press('Enter');
    await h(courseCard,title).waitFor();
  }
  async function lastWrong(){
    await see(courseCard,'Attempts remaining: 1');
    for(const option of ['An unsigned draft','Post it publicly','Ignore the policy','I read the assigned fictional policy edition.']){
      const control=courseCard.getByLabel(option,{exact:true});
      await control.press('Space');
      assert.equal(await control.isChecked(),true);
    }
    const pending=learner.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===learn+'/complete');
    await b(courseCard,'Submit answers').press('Enter');
    const reply=await pending;assert.equal(reply.status(),200);
    assert.equal(new URL(reply.url()).search,'');
    return (await reply.json()).lesson;
  }

  await openAssignment();
  const pinned=courseCard.locator('summary').filter({hasText:'Read assigned policy: '+policyTitle+' · edition 1'});
  await pinned.press('Enter');
  await see(courseCard,policyText);
  active=await lastWrong();
  assert.equal(active.status,'retry-required');
  assert.equal(active.attempts,5);
  assert.equal(active.attemptsRemaining,0);
  await see(courseCard,firstExhaustion);
  assert.equal(active.resetAvailable,true);
  assert.equal(await b(courseCard,'Submit answers').count(),0);

  const analyst=await page();
  await analyst.goto(f.url);
  await analyst.getByLabel('Test account',{exact:true}).fill(author.id);
  await analyst.getByLabel('Workspace ID',{exact:true}).fill('harbor');
  await analyst.getByLabel('Local access code',{exact:true}).fill(author.code);
  await b(analyst,'Sign in').press('Enter');
  const pane=analyst.locator('#training-view'),card=pane.locator('article').filter({has:h(analyst,title)});
  async function progress(){
    await b(analyst,'Training').press('Enter');
    await h(card,title).waitFor();
    await card.locator('summary').filter({hasText:'Learner progress'}).press('Enter');
  }
  await progress();
  await see(card,issued.alias+' · retry required · 5 attempts');
  const resetting=analyst.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===training+'/reset');
  await b(card,'Reset exhausted attempts').press('Enter');
  const response=await resetting;
  assert.equal(response.status(),200);
  assert.equal(new URL(response.url()).searchParams.get('workspace'),'harbor');
  const restored=(await response.json()).assignments.find(x=>x.id===assignment.id);
  assert.equal(restored.resetCount,1);
  await openAssignment();
  await see(courseCard,'Attempts remaining: 5');

  active=(await act('lesson',{assignment:assignment.id})).lesson;
  await stageWrong();
  await openAssignment();
  active=await lastWrong();
  assert.equal(active.status,'retry-required');
  assert.equal(active.attempts,10);
  assert.equal(active.attemptsRemaining,0);
  await courseCard.getByText(/No attempts remain/).waitFor();
  assert.equal(await courseCard.getByText(firstExhaustion,{exact:true}).count(),0,
    'Learner is told to request an impossible second reset.');
  await see(courseCard,finalExhaustion);
  assert.equal(active.resetAvailable,false);
  assert.equal(await b(courseCard,'Submit answers').count(),0);
  assert.equal(await courseCard.getByText('Completion receipt',{exact:true}).count(),0);
  await openAssignment();
  await see(courseCard,finalExhaustion);

  await analyst.reload();await progress();
  await see(card,issued.alias+' · retry required · 10 attempts');
  assert.equal(await b(card,'Reset exhausted attempts').count(),0);
  const retry=(await f.request(training+'/reset',{cookie:a,body:{assignment:assignment.id,revision:active.revision},status:409})).data;
  assert.equal(retry.code,'TRAINING_RESET_UNAVAILABLE');
  const final=(await staff(training)).assignments.find(x=>x.id===assignment.id);
  assert.equal(final.attempts,10);
  assert.equal(final.resetCount,1);
  assert.equal(final.receipt,null);
  const audit=(await staff('/api/audit/export',r)).audit.filter(x=>x.entityId===assignment.id);
  assert.equal(audit.filter(x=>x.action==='training.assignment-reset').length,1);
  assert.equal(audit.filter(x=>x.action==='training.attempted').length,10);
  assert.equal(audit.filter(x=>x.action==='training.completed').length,0);

  const orchard=await openLearner(outsider);
  await see(orchard,'No training is assigned to this synthetic learner.');
  assert.equal(await b(orchard,'Open '+title).count(),0);
  await act('lesson',{assignment:assignment.id},404,outsider);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
