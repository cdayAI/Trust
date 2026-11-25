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
const browserOnly={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Chromium and Playwright',timeout:50_000};
const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
const see=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
const card=(page,scope,title)=>scope.locator('article').filter({has:h(page,title)});
const exact=(scope,value)=>scope.locator('summary').filter({hasText:new RegExp('^'+value+'$')});

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'mvw-browser-decisions-'));
  const codes=Object.fromEntries(['analyst','reviewer'].map(role=>[role,randomBytes(32).toString('base64url')]));
  const opts={sqliteFile:join(root,'state.sqlite'),isolated:{
    root:join(root,'workspaces'),workspaces:[{id:'alpha',label:'Fictional Alpha'}],
    accounts:Object.keys(codes).map(role=>({id:'qa-'+role,memberships:{alpha:role},codeHash:codeHash(codes[role])}))
  }};
  let server,url;
  async function start(){
    server=createServer(opts).listen(0,'127.0.0.1');await once(server,'listening');
    url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){
    if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r))}
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const actions=[],errors=[],offsite=[];
  const account=role=>({account:'qa-'+role,workspace:'alpha',code:codes[role]});
  async function call(path,cookie,body,login=false){
    const response=await fetch(url+'/api/'+path+(login?'':'?workspace=alpha'),{
      method:body===undefined?'GET':'POST',
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:url})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=await response.json();
    assert.equal(response.status,200,JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const token=async role=>(await call('session/login',null,account(role),true)).cookie;
  async function sign(role){
    const p=await browser.newPage({viewport:{width:1440,height:980}});
    p.setDefaultTimeout(6500);p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',route=>{
      if(new URL(route.request().url()).origin===url)return route.continue();
      offsite.push(route.request().url());return route.abort();
    });
    await p.goto(url);
    await p.getByLabel('Test account').fill(account(role).account);
    await p.getByLabel('Workspace ID').fill('alpha');
    await p.getByLabel('Local access code').fill(codes[role]);
    await b(p,'Sign in').press('Enter');
    await see(p,'qa-'+role+' · '+role);
    return p;
  }
  async function action(scope,control,expected,witness){
    await b(scope,control).press('Enter');
    await witness();actions.push({control,expected});
  }
  async function decision(page,scope,actionName,noteName,note){
    const summary=exact(scope,actionName);
    await summary.press('Space');
    assert.equal(await summary.evaluate(e=>e.parentElement.open),true);
    actions.push({control:actionName+' disclosure',expected:'Expanded via Space'});
    const field=scope.locator('details[open]').getByLabel(noteName,{exact:true});
    await page.keyboard.press('Tab');
    assert.equal(await field.evaluate(e=>e===document.activeElement),true);
    await page.keyboard.insertText(note);
    assert.equal(await field.inputValue(),note);
    actions.push({control:noteName,expected:'Tab landed at the note; exact fictional decision entered'});
    await page.keyboard.press('Tab');
    const commit=b(scope,actionName);
    assert.equal(await commit.evaluate(e=>e===document.activeElement),true);
  }
  async function commit(page,urlEnding,status,control,outcome,witness){
    const waiter=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(urlEnding));
    await page.keyboard.press('Enter');
    const reply=await waiter;assert.equal(reply.status(),status);
    const data=await reply.json();
    await witness(data);
    actions.push({control,expected:outcome});
    return data;
  }
  return {call,token,sign,action,decision,commit,restart:async()=>{await stop();await start()},finish(){
    assert.deepEqual(errors,[]);assert.deepEqual(offsite,[]);t.diagnostic(JSON.stringify({activated:actions.length,actions}));
  }};
}

test('Chromium notice conflict: keyboard publish wins; stale return cannot change it or another channel, even after SQLite restart',browserOnly,async t=>{
  const f=await fixture(t),a=await f.token('analyst'),r=await f.token('reviewer');
  const base='privacy-notices',scopeName='synthetic-concurrent-review';
  let rev=0;
  async function api(path,seat,fields={}){
    const {data}=await f.call(base+'/'+path,seat,{expectedRevision:rev,...fields});rev=data.revision;return data;
  }
  async function staged(title,channel,content,published){
    const created=await api('notices',a,{title,channel,content,scope:scopeName});
    const row=created.notices.find(x=>x.title===title);
    await api('notices/'+row.id+'/submit',a);
    if(published)await api('notices/'+row.id+'/publish',r,{note:'Synthetic baseline independent approval.'});
    return row;
  }
  const v1=await staged('Earlier fictional web notice','web','Earlier web copy stays in history.',true);
  const mobile=await staged('Separate fictional mobile notice','mobile','Unchanged mobile copy.',true);
  const v2=await staged('Replacement fictional web notice','web','New exact copy for web only.',false);
  const first=await f.sign('reviewer'),stale=await f.sign('reviewer');
  const region=p=>p.locator('#preferences-view');
  const row=(p,record)=>card(p,region(p),record.title);
  for(const p of [first,stale])await f.action(p,'Privacy notices','Reviewer sees exact v2 in review',async()=>{
    await see(row(p,v2),'review');await see(row(p,v1),'published · current');await see(row(p,mobile),'published · current');
  });
  const wins='First reviewer session publishes exact fictional copy.';
  const loses='Stale reviewer session should not return it.';
  await f.decision(first,row(first,v2),'Publish locally','Fictional reviewer rationale',wins);
  await f.decision(stale,row(stale,v2),'Return to draft','Fictional reviewer rationale',loses);
  await f.commit(first,'/publish',200,'Publish locally','First session publishes reviewed web v2',async()=>{
    await see(row(first,v2),'published · current');await see(row(first,v1),'published');await see(row(first,mobile),'published · current');
  });
  await f.commit(stale,'/return',409,'Return to draft','Stale outcome refused by revision, reload required',async data=>{
    assert.equal(data.code,'STALE_REVISION');
    await b(stale,'Reload notices').waitFor();
  });
  await f.action(stale,'Reload notices','Reload shows published outcome, not the stale decision',async()=>{
    await see(row(stale,v2),'published · current');await see(row(stale,v2),'Reviewer: '+wins);
    assert.equal(await exact(row(stale,v2),'Return to draft').count(),0);
    assert.equal(await exact(row(stale,v2),'Publish locally').count(),0);
  });
  await f.restart();
  const reopened=await f.sign('reviewer');
  await f.action(reopened,'Privacy notices','SQLite reopened with only the winning exact publication',async()=>{
    await see(row(reopened,v2),'published · current');
    await see(row(reopened,v1),'published');await see(row(reopened,v1),v1.content);
    await see(row(reopened,mobile),'published · current');await see(row(reopened,mobile),mobile.content);
    await see(row(reopened,v2),'Reviewer: '+wins);
    assert.equal(await region(reopened).getByText(new RegExp(loses)).count(),0);
  });
  const {data:{audit}}=await f.call('audit/export',await f.token('reviewer'));
  const events=audit.filter(x=>x.entityId===v2.id);
  assert.equal(events.filter(x=>x.action==='privacy-notices.notice.publish'&&x.account==='qa-reviewer').length,1);
  assert.equal(events.filter(x=>x.action==='privacy-notices.notice.return').length,0);
  assert.equal(events.filter(x=>x.action==='privacy-notices.refused'&&x.details.code==='STALE_REVISION').length,1);
  f.finish();
});

test('Chromium retention supersession: stale audit simulation refuted, updated preview opens by keyboard and persists as audit only',browserOnly,async t=>{
  const f=await fixture(t),a=await f.token('analyst'),r=await f.token('reviewer');
  const base='retention',category='demo-operations',reference='SYN-STALEPREVIEW',date='2005-03-01';
  let rev=0;
  async function api(path,seat,fields={}){
    const {data}=await f.call(base+'/'+path,seat,{expectedRevision:rev,...fields});rev=data.revision;return data;
  }
  async function staged(title,trigger,days,disposition,published){
    const created=await api('schedules',a,{title,category,trigger,days,disposition});
    const row=created.schedules.find(s=>s.title===title);
    await api('schedules/'+row.id+'/submit',a);
    if(published)await api('schedules/'+row.id+'/activate',r,{note:'Baseline fictional retention scope approved.'});
    return row;
  }
  const old=await staged('Earlier fictional retention','created',1,'archive',true);
  const created=await api('records',a,{reference,category,createdOn:'2005-02-10',closedOn:'2005-02-20'});
  const record=created.records[0];
  const initial=(await api('previews',a,{recordId:record.id,asOf:date})).previews[0];
  const next=await staged('Replacement fictional retention','closed',3,'anonymize',false);
  const analyst=await f.sign('analyst'),reviewer=await f.sign('reviewer');
  const region=p=>p.locator('#retention-view');
  const results=p=>region(p).locator('section').filter({has:h(p,'Disposition previews and results')});
  const preview=(p,v)=>card(p,results(p),reference).filter({hasText:'Schedule: v'+v+' ·'});
  const schedule=(p,s)=>card(p,region(p),s.title);
  await f.action(analyst,'Retention','Analyst has a real, eligible v1 preview captured before replacement',async()=>{
    await see(preview(analyst,1),'Eligible for audit-only simulation');
    await b(preview(analyst,1),'Record audit-only simulation').waitFor();
  });
  await f.action(reviewer,'Retention','Reviewer sees v2 in review and v1 Current',async()=>{
    await see(schedule(reviewer,old),'Current');await see(schedule(reviewer,next),'review');
  });
  await f.decision(reviewer,schedule(reviewer,next),'Activate schedule','Fictional review note','Independent v2 changes both trigger and disposition.');
  await f.commit(reviewer,'/activate',200,'Activate schedule','The independently approved closing-date v2 takes precedence',async()=>{
    await see(schedule(reviewer,next),'Current');await see(schedule(reviewer,old),'Historical activated');
  });
  await b(preview(analyst,1),'Record audit-only simulation').focus();
  await f.commit(analyst,'/simulate',409,'Record audit-only simulation','Old tab refuses stale request and offers reload',async data=>{
    assert.equal(data.code,'STALE_REVISION');
    await b(analyst,'Reload retention').waitFor();
  });
  await f.action(analyst,'Reload retention','Current v2 shown; superseded v1 preview no longer offers simulation',async()=>{
    await see(schedule(analyst,next),'Current');
    assert.equal(await b(preview(analyst,1),'Record audit-only simulation').count(),0,
      'A known-superseded preview must not still present a dead simulation action');
    await see(preview(analyst,1),'Historical preview: the active schedule has changed.');
  });
  await f.action(preview(analyst,1),'Create updated preview','Keyboard action focuses the same fixture’s simulation date',async()=>{
    const dateField=region(analyst).getByLabel('Simulation UTC date',{exact:true});
    assert.equal(await dateField.evaluate(e=>e===document.activeElement),true);
    assert.equal(await dateField.inputValue(),date);
  });
  const recordFixture=region(analyst).locator('section').filter({has:h(analyst,'Fictional record fixtures')});
  await f.action(recordFixture,'Save disposition preview','New preview uses closed-date rule and the expected due date',async()=>{
    await see(preview(analyst,2),'Schedule: v2 · Due: 2005-02-23 · Active holds at preview: 0');
    await see(preview(analyst,2),'Eligible for audit-only simulation');
  });
  await b(preview(analyst,2),'Record audit-only simulation').focus();
  await f.commit(analyst,'/simulate',200,'Record audit-only simulation','Only the updated version logs an audit-only result',()=>see(preview(analyst,2),'Audit-only simulation recorded: anonymize. No record changed.'));
  await f.restart();
  const reopened=await f.sign('analyst');
  await f.action(reopened,'Retention','The result and untouched fixture remain after SQLite restart',async()=>{
    await see(preview(reopened,2),'Audit-only simulation recorded: anonymize. No record changed.');
    await see(region(reopened),'demo-operations · Created 2005-02-10 · Closed 2005-02-20');
    await see(preview(reopened,1),'Historical preview: the active schedule has changed.');
    assert.equal(await b(preview(reopened,1),'Record audit-only simulation').count(),0);
  });
  const {data}=await f.call(base,await f.token('analyst'));
  assert.deepEqual(data.records,[record]);
  assert.equal(data.runs.length,1);
  assert.equal(data.runs[0].scheduleVersion,2);
  assert.notEqual(data.runs[0].previewId,initial.id);
  assert.equal(data.runs[0].changedRecord,false);
  assert.equal(data.runs[0].deleted,false);
  f.finish();
});
