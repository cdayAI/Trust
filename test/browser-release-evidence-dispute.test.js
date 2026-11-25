'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const title='Synthetic exact edition under dispute';
const authored='Fictional edition text; no deletion or actual work data.';
const attachment=Buffer.from('Fictional attachment still retained.\r\n');
const filename='fictional-preserved-evidence.txt';
const date='2199-12-30',workspace='harbor',base='governance-documents';
const sha=value=>createHash('sha256').update(value).digest('hex');
const b=(scope,label)=>scope.getByRole('button',{name:label,exact:true});
const see=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
const shown=(scope,title)=>scope.getByRole('heading',{name:title,exact:true}).waitFor();
const exact=(scope,text)=>scope.locator('summary').filter({hasText:new RegExp('^'+text+'$')});

async function setup(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-evidence-dispute-'));
  const processArgs=[resolve(__dirname,'../start-release.js'),'--port','0'];
  const child=spawn(process.execPath,processArgs,{cwd:room,env:{...process.env,TMPDIR:room,TMP:room,TEMP:room},
    stdio:['ignore','pipe','pipe']});
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
  const seats=Object.fromEntries(['analyst','reviewer'].map(role=>[role,access.staff.find(s=>s.memberships[workspace]===role)]));
  const api=async(path,cookie,body,scope=workspace)=>{
    const reply=await fetch(live.url+'/api/'+path+(scope?'?workspace='+scope:''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:live.url,'Content-Type':'application/json'})},
      signal:AbortSignal.timeout(6500)
    });
    assert.equal(reply.status,200,path+' status '+reply.status);
    return {data:await reply.json(),cookie:reply.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async role=>(await api('session/login',null,{account:seats[role].id,workspace,code:seats[role].code},null)).cookie;
  const a=await login('analyst'),r=await login('reviewer');
  const mutate=(path,body,role=a)=>api(path,role,body).then(x=>x.data);
  const draft=await mutate('retention/schedules',{expectedRevision:0,category:'demo-operations',title:'Synthetic evidence preservation rule',
    trigger:'created',days:2,disposition:'delete'});
  const rule=draft.schedules[0],rulePath='retention/schedules/'+rule.id;
  await mutate(rulePath+'/submit',{expectedRevision:1});
  await mutate(rulePath+'/activate',{expectedRevision:2,note:'Fictional independent rule approval.'},r);
  const documents=await mutate(base+'/records',{expectedRevision:0,kind:'policy',title,content:authored,links:[]});
  const doc=documents.documents[0],edition=doc.revisions[0],path=base+'/records/'+doc.id+'/revisions/'+edition.id;
  const uploaded=await mutate(path+'/attachments',{expectedRevision:1,filename,mediaType:'text/plain',data:attachment.toString('base64')});
  const file=uploaded.documents[0].revisions[0].attachments[0];
  assert.equal(file.reviewStatus,'pending');
  await mutate(path+'/attachments/'+file.id+'/review',{expectedRevision:2,operation:'release',sha256:file.sha256},r);
  await mutate(path+'/submit',{expectedRevision:3});
  const published=await mutate(path+'/publish',{expectedRevision:4,note:'Independently approved fixture.'},r);
  return {url:live.url,seats,api,a,r,rule,doc,edition:published.documents[0].revisions[0]};
}

test('composed release Chromium: evidence hold dispute blocks stale disposal, then keeps exact bytes after independent rehearsal',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:65_000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const out=[],errors=[],external=[];
  async function act(scope,control,witness){
    await b(scope,control).press('Enter');await witness();
    out.push({control,witness:'Keyboard activation changed the asserted pane state'});
  }
  async function post(p,scope,control,ending,status,code,witness){
    const waits=p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(ending));
    await act(scope,control,async()=>{
      const reply=await waits;assert.equal(reply.status(),status);
      const body=await reply.json();
      if(code)assert.equal(body.code,code);
      await witness(body);
    });
    out.at(-1).endpoint=ending;out.at(-1).status=status;
    if(code)out.at(-1).code=code;
  }
  async function page(role){
    const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true,reducedMotion:'reduce'});
    p.setDefaultTimeout(6500);p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.url)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    await p.goto(f.url);
    const seat=f.seats[role];
    await p.getByLabel('Test account').fill(seat.id);
    await p.getByLabel('Workspace ID').fill(workspace);
    await p.getByLabel('Local access code').fill(seat.code);
    await b(p,'Sign in').press('Enter');
    await see(p.locator('#local-account'),seat.id+' · '+role);
    return p;
  }
  const analyst=await page('analyst'),reviewer=await page('reviewer');
  const card=p=>p.locator('#work-record-'+f.edition.id);
  const hold=p=>card(p).locator('section').filter({has:p.getByRole('heading',{name:'Evidence preservation hold',exact:true})});
  const disposition=p=>card(p).locator('section').filter({has:p.getByRole('heading',{name:'Evidence disposition rehearsal',exact:true})});
  const snapshot=async(cookie=f.a)=>(await f.api(base,cookie)).data.documents.find(x=>x.id===f.doc.id).revisions.find(x=>x.id===f.edition.id);
  const refresh=async(p,check)=>{
    await act(p,'Policies and documents',async()=>{await shown(card(p),title);await check();});
  };
  async function disclosure(scope,name){
    const summary=exact(scope,name);
    await summary.press('Space');
    assert.equal(await summary.evaluate(e=>e.parentElement.open),true);
    out.push({control:name+' disclosure',witness:'Keyboard Space expanded the exact form'});
    return scope.locator('details[open]').filter({hasText:name});
  }
  async function choose(scope,label,value){
    const field=scope.getByLabel(label,{exact:true});
    await field.selectOption(value);
    assert.equal(await field.inputValue(),value);
    out.push({control:label,witness:'Fictional value '+value+' selected'});
  }
  async function fillDate(scope,value){
    const field=scope.getByLabel('Fictional as-of date',{exact:true});
    await field.fill(value);
    assert.equal(await field.inputValue(),value);
    out.push({control:'Fictional as-of date',witness:'Date input preserved '+value});
  }
  async function holdAction(p,name,route,reason,state){
    const form=await disclosure(hold(p),name);
    await choose(form,'Fictional hold reason',reason);
    await post(p,form,name,'/evidence-hold/'+route,200,undefined,()=>see(hold(p),state));
  }
  async function previewCheck(asOf,status,code){
    const scope=await disclosure(disposition(analyst),'Preview evidence disposition');
    await choose(scope,'Fictional retention rule',f.rule.id);await fillDate(scope,asOf);
    await post(analyst,scope,'Preview evidence disposition','/evidence-disposition/preview',status,code,async data=>{
      if(code){
        await see(analyst.locator('#notice'),data.error);
        assert.equal((await snapshot()).evidenceRehearsal,undefined);
      }else{
        await see(disposition(analyst),'Preview awaiting independent rehearsal.');
        await disposition(analyst).getByText(/^Pinned rule v1 · fictional delete/).waitFor();
      }
    });
  }

  await refresh(analyst,()=>see(hold(analyst),'No outstanding hold.'));
  await previewCheck('2000-01-01',409,'EVIDENCE_NOT_DUE');
  const retainedForm=disposition(analyst).locator('details[open]');
  assert.equal(await retainedForm.getByLabel('Fictional retention rule',{exact:true}).inputValue(),f.rule.id);
  await fillDate(retainedForm,date);
  await post(analyst,retainedForm,'Preview evidence disposition','/evidence-disposition/preview',200,undefined,
    ()=>see(disposition(analyst),'Preview awaiting independent rehearsal.'));
  const initial=(await snapshot()).evidenceRehearsal.id;
  await refresh(reviewer,()=>b(disposition(reviewer),'Record rehearsal only').waitFor());
  await holdAction(analyst,'Place evidence hold','place','audit-review','Hold active');
  await see(disposition(analyst),'An outstanding hold blocks this rehearsal.');
  assert.equal(await exact(disposition(analyst),'Preview evidence disposition').count(),0);
  await post(reviewer,disposition(reviewer),'Record rehearsal only','/evidence-disposition/rehearse',409,'STALE_REVISION',
    ()=>b(reviewer,'Reload documents').waitFor());
  assert.equal((await snapshot()).evidenceRehearsal.status,'requested');
  await act(reviewer,'Reload documents',async()=>{
    await see(hold(reviewer),'Hold active');
    await see(disposition(reviewer),'An outstanding hold blocks this rehearsal.');
    assert.equal(await b(disposition(reviewer),'Record rehearsal only').count(),0);
  });

  const waiting='Hold active · release awaiting independent review';
  await holdAction(analyst,'Request hold release','request-release','review-complete',waiting);
  await refresh(reviewer,()=>see(hold(reviewer),waiting));
  await holdAction(reviewer,'Keep evidence hold','return-release','keep-preserving','Hold active');
  await see(disposition(reviewer),'An outstanding hold blocks this rehearsal.');
  assert.equal((await snapshot()).evidenceHold.status,'active');
  await refresh(analyst,()=>see(hold(analyst),'Hold active'));
  await holdAction(analyst,'Request hold release','request-release','review-complete',waiting);
  await refresh(reviewer,()=>see(hold(reviewer),waiting));
  await holdAction(reviewer,'Approve hold release','approve-release','hold-no-longer-needed','Last hold released · evidence retained');
  await see(disposition(reviewer),'The pinned rule or hold history changed. Request a new preview.');
  assert.equal(await b(disposition(reviewer),'Record rehearsal only').count(),0);
  await refresh(analyst,()=>see(hold(analyst),'Last hold released · evidence retained'));
  await previewCheck(date,200);
  const fresh=(await snapshot()).evidenceRehearsal.id;
  assert.notEqual(fresh,initial);
  await refresh(reviewer,()=>b(disposition(reviewer),'Record rehearsal only').waitFor());
  await post(reviewer,disposition(reviewer),'Record rehearsal only','/evidence-disposition/rehearse',200,undefined,async()=>{
    await disposition(reviewer).getByText(/^Rehearsal recorded · evidence retained\. Receipt /).waitFor();
    assert.equal(await b(disposition(reviewer),'Record rehearsal only').count(),0);
  });

  await reviewer.reload();
  await refresh(reviewer,()=>disposition(reviewer).getByText(/^Rehearsal recorded · evidence retained\. Receipt /).waitFor());
  await act(card(reviewer),'View fictional text',()=>see(card(reviewer),authored));
  const files=reviewer.waitForEvent('download');
  await act(card(reviewer),'Download attachment '+filename,async()=>{
    const file=await files;
    assert.equal(file.suggestedFilename(),filename);
    const parts=[];for await(const part of await file.createReadStream())parts.push(part);
    assert.deepEqual(Buffer.concat(parts),attachment);
    assert.equal(sha(Buffer.concat(parts)),f.edition.attachments[0].sha256);
  });
  const after=await snapshot(f.r);
  assert.equal(after.contentHash,f.edition.contentHash);
  assert.deepEqual(after.attachments,f.edition.attachments);
  assert.equal(after.evidenceRehearsal.id,fresh);
  assert.equal(after.evidenceRehearsal.status,'rehearsed');
  assert.equal(after.evidenceHold.status,'released');
  const {data:{audit}}=await f.api('audit/export',f.r);
  const rehearsed=audit.filter(e=>e.action==='governance-documents.evidence-disposition.rehearse');
  assert.equal(rehearsed.length,1);
  assert.equal(rehearsed[0].account,f.seats.reviewer.id);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  t.diagnostic(JSON.stringify({activated:out.length,out}));
});
