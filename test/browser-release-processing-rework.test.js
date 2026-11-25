'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const path='/api/processing-register',map='/api/data-map',dict='/api/dictionary/terms',retention='/api/retention/schedules';
const entryTitle='Fictional processing rework',newTitle='Fictional processing rework corrected';
const oldDataset='Fictional original dataset',newDataset='Fictional renamed dataset';
const oldTerm='Fictional first purpose term',newTerm='Fictional approved purpose edition two';
const oldSchedule='Fictional initial retention',newSchedule='Fictional replacement retention';
const note='Synthetic reference rehearsal only.';
const b=(s,name)=>s.getByRole('button',{name,exact:true});
const h=(s,name)=>s.getByRole('heading',{name,exact:true});
const see=(s,value)=>s.getByText(value,{exact:true}).waitFor();

async function setup(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-processing-rework-'));
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

test('composed Chromium: processing draft and pending reference drift require a correction without rewriting approved bytes',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:65_000
},async t=>{
  const f=await setup(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const a=await f.login('analyst'),r=await f.login('reviewer'),o=await f.login('reviewer','orchard'),restricted=await f.login('case-operator');
  const send=(route,body,cookie=a)=>f.request(route,{body,cookie}).then(x=>x.data);
  const get=(route,cookie=a)=>f.request(route,{cookie}).then(x=>x.data);
  const outside=[],errors=[];
  const nodes={};let m=await get(map);
  for(const [type,name] of [['system','Fictional primary host'],['dataset',oldDataset],['activity','Fictional inventory activity']]){
    m=await send(map+'/nodes',{expectedRevision:m.revision,type,name,owner:'Fictional operational group',detail:note});
    nodes[type]=m.nodes.find(row=>row.name===name).id;
  }
  for(const [type,from,to] of [['hosts','system','dataset'],['reads','dataset','activity']]){
    m=await send(map+'/links',{expectedRevision:m.revision,type,fromId:nodes[from],toId:nodes[to],note});
  }
  async function schedule(title,days){
    const current=await get('/api/retention');
    const created=await send(retention,{expectedRevision:current.revision,title,category:'demo-customer',days,trigger:'closed',disposition:'delete'});
    const next=created.schedules.find(row=>row.title===title);
    const proposed=await send(retention+'/'+next.id+'/submit',{expectedRevision:created.revision});
    const active=await send(retention+'/'+next.id+'/activate',{expectedRevision:proposed.revision,note},r);
    return active.schedules.find(row=>row.id===next.id);
  }
  let d=await send(dict,{expectedRevision:0,title:oldTerm,definition:note,slug:'fictional-processing-purpose',type:'purpose'});
  const term=d.terms.find(row=>row.slug==='fictional-processing-purpose').id;
  const termPath=dict+'/'+term;
  async function approveTerm(v){
    d=await send(termPath+'/submit',{expectedRevision:d.revision,version:v});
    d=await send(termPath+'/approve',{expectedRevision:d.revision,version:v},r);
  }
  await approveTerm(1);
  const v1rule=await schedule(oldSchedule,90);
  let row=(await send(path+'/entries',{details:{
    title:entryTitle,purpose:note,ownerRole:'serviceOwner',stewardRole:'recordsSteward',
    activityId:nodes.activity,systems:[nodes.system],datasets:[nodes.dataset],terms:[term],retentionSchedules:[v1rule.id],
    subjects:['demoCustomers'],dataCategories:['demoAccount'],recipients:[]
  }})).entries[0];
  const entry=path+'/entries/'+row.id;
  row=(await send(entry+'/submit',{expectedRevision:row.revision})).entries[0];
  row=(await send(entry+'/publish',{expectedRevision:row.revision,note},r)).entries[0];
  const stored=async()=> (await get(path)).entries.find(x=>x.id===row.id);

  async function visit(role,workspace='harbor'){
    const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true,reducedMotion:'reduce'});
    p.setDefaultTimeout(6500);
    p.on('pageerror',error=>errors.push(error.message));
    await p.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===f.url)return route.continue();
      outside.push(url.origin);return route.abort();
    });
    const {id,code}=f.seat(workspace,role);
    await p.goto(f.url);
    await p.getByLabel('Test account',{exact:true}).fill(id);
    await p.getByLabel('Workspace ID',{exact:true}).fill(workspace);
    await p.getByLabel('Local access code',{exact:true}).fill(code);
    await b(p,'Sign in').press('Enter');
    if(role!=='case-operator')await openPanel(p);
    else await p.locator('#workbench').waitFor();
    return p;
  }
  async function openPanel(p){
    await b(p,'Processing register').press('Enter');
    await h(p.locator('#processing-register-view'),'Processing register').waitFor();
  }
  async function reenter(p){await p.reload();await openPanel(p);}
  const card=(p,title=entryTitle)=>p.locator('#processing-register-view .processing-card').filter({has:h(p,title)});
  async function disclosure(scope,title){
    const summary=scope.locator('summary').filter({hasText:new RegExp('^'+title+'$')});
    await summary.press('Enter');
    const details=summary.locator('..');
    assert.equal(await details.getAttribute('open'),'');
    return details;
  }
  async function formPost(p,control,verb,status=200){
    const pending=p.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===entry+'/'+verb);
    await control.press('Enter');
    const res=await pending;
    assert.equal(res.status(),status,verb);
    assert.equal(new URL(res.url()).searchParams.get('workspace'),'harbor');
    return {data:await res.json(),body:res.request().postDataJSON()};
  }
  async function download(p,caption,expectedPath){
    const link=p.getByRole('link',{name:caption,exact:true});
    const href=new URL(await link.getAttribute('href'),f.url);
    assert.equal(href.pathname,expectedPath);
    assert.equal(href.searchParams.get('workspace'),'harbor');
    const [file]=await Promise.all([p.waitForEvent('download'),link.press('Enter')]);
    assert.equal(file.suggestedFilename(),'mvw-trust-processing-register.json');
    const parts=[];
    for await(const item of await file.createReadStream())parts.push(item);
    return Buffer.concat(parts);
  }
  async function reviewNote(scope,value){await scope.getByLabel('Independent processing review note',{exact:true}).fill(value)}
  async function focus(locator){await locator.waitFor();assert.equal(await locator.evaluate(el=>el===document.activeElement),true,'Expected keyboard focus on '+await locator.textContent())}
  const historical=version=>entry+'/versions/'+version+'/export';
  function verifyBytes(bytes,v){
    const payload=JSON.parse(bytes),saved=payload.entries.find(x=>x.entryId===row.id);
    assert.equal(saved.version,v);
    assert.equal(saved.contentSha256,createHash('sha256').update(JSON.stringify(saved.processing)).digest('hex'));
    assert.equal(saved.processing.activity.id,nodes.activity);
    assert.deepEqual(saved.processing.lineage.map(e=>e.type).sort(),['hosts','reads']);
    return saved;
  }

  const analyst=await visit('analyst');
  await disclosure(card(analyst),'Approved version history');
  const before=await download(analyst,'Download approved version 1',historical(1));
  const old=verifyBytes(before,1).processing;
  assert.equal(old.datasets[0].name,oldDataset);
  assert.equal(old.dictionaryTerms[0].version,1);
  assert.equal(old.retentionSchedules[0].days,90);
  await formPost(analyst,b(card(analyst),'Draft next processing version'),'revise');
  await see(card(analyst),'draft');
  await send(map+'/nodes/'+nodes.dataset+'/update',{expectedRevision:m.revision,name:newDataset,owner:'Fictional operational group',detail:note});
  await see(card(analyst).locator('.processing-summary'),oldDataset);
  const submitted=(await formPost(analyst,b(card(analyst),'Submit processing entry'),'submit')).data.entries[0];
  assert.equal(submitted.versions.at(-1).snapshot.datasets[0].name,newDataset);
  assert.equal(submitted.versions.at(-1).snapshot.dictionaryTerms[0].version,1);
  await see(card(analyst).locator('.processing-summary'),newDataset);
  const underReview=await download(analyst,'Download current approved register',path+'/export');
  assert.deepEqual(underReview,before);

  d=await send(termPath+'/revise',{expectedRevision:d.revision,title:newTerm,definition:'Fictional purpose edition two.'});
  await approveTerm(2);
  const v2rule=await schedule(newSchedule,180);
  assert.notEqual(v2rule.id,v1rule.id);

  const reviewer=await visit('reviewer'),stale=await visit('reviewer');
  assert.equal(await b(reviewer,'Draft next processing version').count(),0);
  assert.equal(await b(analyst,'Approve and publish entry').count(),0);
  await reviewNote(card(reviewer),'Review detects stale typed references.');
  const drift=await formPost(reviewer,b(card(reviewer),'Approve and publish entry'),'publish',409);
  assert.equal(drift.data.code,'PROCESSING_REFERENCES_CHANGED');
  await see(reviewer,'A linked map, dictionary, or retention reference changed. Return the version for correction.');
  assert.equal((await stored()).revision,submitted.revision);
  assert.equal((await stored()).versions.at(-1).status,'in_review');
  await see(card(reviewer),oldTerm+' v1');
  await reviewNote(card(reviewer),'Return until dictionary and retention references are current.');
  const returned=await formPost(reviewer,b(card(reviewer),'Return processing entry'),'return');
  assert.equal(returned.data.entries[0].versions.at(-1).status,'returned');
  await see(card(reviewer),'returned');
  await reviewNote(card(stale),'Do not overwrite the independent return.');
  const refused=await formPost(stale,b(card(stale),'Approve and publish entry'),'publish',409);
  assert.equal(refused.data.code,'STALE_REVISION');
  assert.equal(refused.body.expectedRevision,returned.body.expectedRevision);
  const message='The entry changed. Reload before retrying.';
  await stale.getByText(message).waitFor();
  assert.notEqual(await stale.evaluate(()=>document.activeElement.tagName),'BODY','Stale processing review loses keyboard focus.');
  await focus(card(stale).getByRole('alert').filter({hasText:message}));
  await stale.keyboard.press('Tab');
  const retry=b(card(stale),'Reload processing register');
  await focus(retry);
  const readBack=stale.waitForResponse(res=>res.request().method()==='GET'&&new URL(res.url()).pathname===path);
  await retry.press('Enter');assert.equal((await readBack).status(),200);
  await focus(h(card(stale),entryTitle));
  await see(card(stale),'returned');
  assert.equal(await b(card(stale),'Approve and publish entry').count(),0);
  assert.equal(await card(stale).getByRole('alert').count(),0);

  await reenter(analyst);
  const editor=await disclosure(card(analyst),'Edit draft processing entry');
  await see(editor,'Prior selection is no longer eligible. Choose an eligible replacement.');
  const term2=editor.getByRole('checkbox',{name:newTerm+' · purpose · v2',exact:true});
  const rule2=editor.getByRole('checkbox',{name:newSchedule+' · v2',exact:true});
  assert.equal(await term2.isChecked(),true);
  assert.equal(await rule2.isChecked(),false);
  assert.equal(await editor.getByRole('checkbox',{name:oldSchedule+' · v1',exact:true}).count(),0);
  await rule2.press('Space');
  assert.equal(await rule2.isChecked(),true);
  assert.equal(await b(card(analyst),'Submit processing entry').isDisabled(),true);
  await editor.getByLabel('Entry title',{exact:true}).fill(newTitle);
  const saved=await formPost(analyst,b(editor,'Save processing changes'),'edit');
  assert.deepEqual(saved.body.details.terms,[term]);
  assert.deepEqual(saved.body.details.retentionSchedules,[v2rule.id]);
  await h(card(analyst,newTitle),newTitle).waitFor();
  const ready=await formPost(analyst,b(card(analyst,newTitle),'Submit processing entry'),'submit');
  const correction=ready.data.entries[0].versions.at(-1);
  assert.equal(correction.status,'in_review');
  assert.equal(correction.snapshot.datasets[0].name,newDataset);
  assert.equal(correction.snapshot.dictionaryTerms[0].version,2);
  assert.equal(correction.snapshot.retentionSchedules[0].id,v2rule.id);
  assert.equal(correction.snapshot.retentionSchedules[0].version,2);
  await reenter(reviewer);
  const corrected=card(reviewer,newTitle);
  await see(corrected,newTerm+' v2');
  await see(corrected,newSchedule+' v2 · 180 days');
  await reviewNote(corrected,'Reviewed current fictional lineage and typed references independently.');
  await formPost(reviewer,b(corrected,'Approve and publish entry'),'publish');
  await see(corrected,'published');
  const current=await download(reviewer,'Download current approved register',path+'/export');
  const latest=verifyBytes(current,2);
  assert.equal(latest.processing.datasets[0].name,newDataset);
  assert.equal(latest.processing.dictionaryTerms[0].id,term);
  assert.notEqual(latest.contentSha256,verifyBytes(before,1).contentSha256);
  await disclosure(corrected,'Approved version history');
  assert.deepEqual(await download(reviewer,'Download approved version 1',historical(1)),before);
  assert.deepEqual(await download(reviewer,'Download approved version 2',historical(2)),current);

  const orchard=await visit('reviewer','orchard'),limited=await visit('case-operator');
  await see(orchard,'No processing entries yet.');
  assert.equal(await orchard.locator('.processing-card').count(),0);
  assert.equal(await b(limited,'Processing register').count(),0);
  await f.request(path,{cookie:restricted,status:403});
  await f.request(historical(1),{cookie:o,workspace:'orchard',status:404});
  assert.deepEqual((await f.request(path+'/export',{cookie:o,workspace:'orchard'})).data.entries,[]);
  const history=(await f.request('/api/audit/export',{cookie:r})).data.audit.filter(e=>e.entityId===row.id);
  assert.deepEqual(history.filter(e=>e.action==='processing-register.publish').map(e=>e.details.version),[1,2]);
  assert.deepEqual(history.filter(e=>e.action==='processing-register.return').map(e=>e.details.version),[2]);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
});
