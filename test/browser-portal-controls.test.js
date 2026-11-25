'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const enabled={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires installed Playwright and Chromium',timeout:40_000};
const secret=()=>randomBytes(32).toString('base64url');
const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
const label=(scope,name)=>scope.getByLabel(new RegExp('^'+escape(name)));
const seen=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
const begins=(scope,text)=>scope.getByText(new RegExp('^'+escape(text))).waitFor();
const gone=(scope,text)=>scope.getByText(text,{exact:true}).waitFor({state:'hidden'});
const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
const section=(page,root,name)=>root.locator('section').filter({has:h(page,name)});
const revisionCard=(page,root,name)=>root.locator('article > section[id^="work-record-"]').filter({has:h(page,name)});
const article=(page,root,name)=>root.locator('article').filter({has:h(page,name)});
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

async function fixture(t,{now=Date.now}={}){
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'mvw-control-'));
  const codes=Object.fromEntries(['analyst','reviewer','case-operator','requester-a','requester-b','employee-a','employee-b','learner-a','learner-b'].map(id=>[id,secret()]));
  const expiresAt=now()+3_600_000;
  const grant=id=>({workspace:'alpha',codeHash:codeHash(codes[id]),expiresAt});
  const options={isolated:{
    root:dir,workspaces:[{id:'alpha',label:'Fictional alpha'}],now,
    accounts:['analyst','reviewer','case-operator'].map(id=>({id,codeHash:codeHash(codes[id]),memberships:{alpha:id}})),
    requesterGrants:['requester-a','requester-b'].map(id=>({id,alias:'sample-'+id,...grant(id)})),
    employeeGrants:['employee-a','employee-b'].map(id=>({alias:'sample-staff-'+id,...grant(id)})),
    trainingGrants:['learner-a','learner-b'].map(id=>({alias:'sample-'+id,...grant(id)})),
    employeeSigningKey:randomBytes(32).toString('hex'),trainingSigningKey:randomBytes(32).toString('hex'),
    trustCenters:[{slug:'sample-qa',workspace:'alpha'}]
  }};
  const server=createServer(options).listen(0,'127.0.0.1');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})});
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const actions=[],observed=[],errors=[],external=[];
  const bind=page=>{
    page.setDefaultTimeout(6500);
    page.on('pageerror',error=>errors.push(error.message));
  };
  async function page(path){
    const context=await browser.newContext({acceptDownloads:true});
    context.on('page',bind);
    await context.route('**/*',route=>{
      if(new URL(route.request().url()).origin===url)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    const tab=await context.newPage();
    if(path!==undefined)await tab.goto(url+path);
    return tab;
  }
  async function click(scope,name,outcome,witness){
    await b(scope,name).click();
    await witness();
    actions.push({control:name,outcome});
  }
  async function fill(scope,name,value){
    const control=label(scope,name);
    await control.fill(value);
    assert.equal(await control.inputValue(),value);
    actions.push({control:name,outcome:'Fictional input entered'});
  }
  async function select(scope,name,value){
    const control=label(scope,name);
    await control.selectOption(value);
    if(typeof value==='string')assert.equal(await control.inputValue(),value);
    else assert.equal(await control.locator('option:checked').innerText(),value.label);
    actions.push({control:name,outcome:'Selected '+(value.label||value)});
  }
  async function disclosure(scope,name){
    const selector=(typeof scope.page==='function'?scope.page():scope).locator('summary').filter({hasText:new RegExp('^'+escape(name)+'$')});
    const summary=scope.locator('summary').and(selector);
    await summary.click();
    assert.equal(await summary.evaluate(e=>e.parentElement.open),true);
    actions.push({control:name,outcome:'Expanded disclosure'});
    return scope.locator('details[open]').filter({has:selector});
  }
  async function absent(scope,role,name){
    assert.equal(await scope.getByRole(role,{name,exact:true}).count(),0);
    observed.push({control:name,outcome:'Correctly unavailable in this state'});
  }
  async function activateLink(page,scope,name,path){
    const link=scope.getByRole('link',{name,exact:true});
    const [target]=await Promise.all([page.waitForEvent('popup'),link.click()]);
    await target.waitForURL(url+path);
    actions.push({control:name,outcome:'Opened '+path});
    return target;
  }
  async function file(scope,name,filename,mimeType,buffer){
    const control=label(scope,name);
    await control.setInputFiles({name:filename,mimeType,buffer});
    await scope.getByRole('button',{name:'Remove selected file '+filename,exact:true}).waitFor();
    actions.push({control:name,outcome:'Selected generated '+filename});
  }
  async function check(scope,name){
    const control=label(scope,name);
    await control.check();
    assert.equal(await control.isChecked(),true);
    actions.push({control:name,outcome:'Confirmed explicit acknowledgment'});
  }
  async function download(page,scope,name,role='link',filename){
    const [file]=await Promise.all([page.waitForEvent('download'),scope.getByRole(role,{name,exact:true}).click()]);
    if(filename)assert.equal(file.suggestedFilename(),filename);
    const chunks=[];for await(const part of await file.createReadStream())chunks.push(part);
    actions.push({control:name,outcome:'Downloaded '+file.suggestedFilename()+'; checked by journey assertion'});
    return Buffer.concat(chunks);
  }
  const cookies={};
  async function call(path,{cookie,body,scoped=true,expected=200}={}){
    const response=await fetch(url+'/api/'+path+(scoped?'?workspace=alpha':''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:url})}
    });
    const data=await response.json();
    assert.equal(response.status,expected,JSON.stringify(data));
    return {data,response};
  }
  async function api(path,actor,body){
    if(actor&&!cookies[actor]){
      const {response}=await call('session/login',{scoped:false,body:{account:actor,workspace:'alpha',code:codes[actor]}});
      cookies[actor]=response.headers.get('set-cookie').split(';')[0];
    }
    return (await call(path,{cookie:cookies[actor],body})).data;
  }
  async function operator(role,tab){
    const workbench=await page('/');
    await fill(workbench,'Test account',role);
    await fill(workbench,'Workspace ID','alpha');
    await fill(workbench,'Local access code',codes[role]);
    await click(workbench,'Sign in','Isolated role landed in the workbench',()=>b(workbench,role==='case-operator'?'Privacy rights':'Assessments').waitFor());
    if(tab)await click(workbench,tab,'Operator pane is available',()=>b(workbench,tab).waitFor());
    return workbench;
  }
  async function publishFixturePolicy(title,text){
    const route='governance-documents/records';
    const {revision:expectedRevision}=await api('governance-documents','analyst');
    const {documents}=await api(route,'analyst',{kind:'policy',title,content:text,links:[],expectedRevision});
    const doc=documents.at(-1);
    const edition=doc.revisions[0],revision=`${route}/${doc.id}/revisions/${edition.id}`;
    await api(revision+'/submit','analyst',{expectedRevision:expectedRevision+1});
    await api(revision+'/publish','reviewer',{expectedRevision:expectedRevision+2,note:'Internal test reviewer note.'});
    return {document:doc.id,edition:edition.id,hash:edition.contentHash};
  }
  return {page,click,fill,select,file,check,disclosure,absent,activateLink,download,api,operator,publishFixturePolicy,codes,finish(){
    assert.deepEqual(errors,[]);
    assert.deepEqual(external,[]);
    t.diagnostic(JSON.stringify({activated:actions.length,observedOnly:observed.length,actions,observed}));
  }};
}

test('browser portal: one fictional privacy request per code, all coarse outcomes, invalid code and clear',enabled,async t=>{
  const f=await fixture(t),page=await f.page('/requester'),code='Synthetic access code';
  const result=page.locator('#portal-result');
  async function sign(value,message){
    await f.fill(page,code,value);
    await f.click(page,'Check my request',message,()=>seen(result,message));
    assert.equal(await label(page,code).inputValue(),'');
  }
  async function clear(){
    await f.click(page,'Clear access code','Rendered status cleared; code regains focus',async()=>{
      assert.equal(await result.innerText(),'');
      assert.equal(await label(page,code).evaluate(e=>e===document.activeElement),true);
    });
    await f.absent(page,'button','Refresh status');
  }
  async function submit(type){
    await f.select(result,'Fictional request type',type);
    await f.click(result,'Submit synthetic request','Request received with selected type',async()=>{
      await h(result,'Received').waitFor();
      await seen(result,'Synthetic request type: '+type);
    });
    const receipt=await result.getByText(/^Receipt: /).innerText();
    await f.absent(result,'button','Submit synthetic request');
    return receipt;
  }
  async function refresh(status,receipt){
    await f.click(result,'Refresh status',status+' with same receipt',async()=>{
      await h(result,status).waitFor();
      await seen(result,receipt);
      assert.doesNotMatch(await result.innerText(),/Internal test|identity|reviewer|analyst/i);
    });
  }
  await sign(secret(),'A valid local synthetic access code is required.');
  await f.absent(page,'button','Clear access code');
  await sign(f.codes['requester-a'],'No request submitted');
  const first=await submit('portability');
  const {cases:[row]}=await f.api('rights/cases','analyst');
  const mutate=(row,action,actor,expectedRevision)=>f.api('rights/cases/'+row.id+'/'+action,actor,{expectedRevision,note:'Internal test reasoning must not leak.'});
  await mutate(row,'verify','reviewer',1);
  await mutate(row,'begin','analyst',2);
  await refresh('In progress',first);
  await mutate(row,'fulfill','analyst',3);
  await refresh('Simulation complete',first);
  await clear();
  await sign(f.codes['requester-b'],'No request submitted');
  const second=await submit('correction');
  assert.notEqual(first,second);
  const next=(await f.api('rights/cases','analyst')).cases.find(x=>x.id!==row.id);
  await mutate(next,'deny-verification','reviewer',1);
  await mutate(next,'close-unverified','analyst',2);
  await refresh('Simulation closed without disclosure',second);
  await clear();
  await sign(f.codes['requester-a'],'Simulation complete');
  await seen(result,first);
  await page.reload();
  await gone(result,first);
  await f.absent(page,'button','Refresh status');
  f.finish();
});

test('browser portal: an expired requester grant clears the intake form on submit',enabled,async t=>{
  let time=Date.now();
  const f=await fixture(t,{now:()=>time}),page=await f.page('/requester'),code='Synthetic access code';
  await f.fill(page,code,f.codes['requester-a']);
  await f.click(page,'Check my request','Requester opened intake',()=>seen(page,'No request submitted'));
  time+=3_600_000;
  await f.click(page,'Submit synthetic request','Expired grant returned to the access form',async()=>{
    await seen(page,'A valid local synthetic access code is required.');
    await gone(page,'No request submitted');
    await f.absent(page,'button','Submit synthetic request');
    assert.equal(await label(page,code).evaluate(input=>input===document.activeElement),true);
  });
  f.finish();
});

test('browser portal: employee can acknowledge exact published policy, clear access, and see zero assignments',enabled,async t=>{
  const f=await fixture(t),title='Fictional local employee privacy policy',text='Fictional edition content employees are asked to read.';
  await f.publishFixturePolicy(title,text);
  const admin=await f.operator('analyst','Policy attestations');
  const root=admin.locator('#employee-attestations-view');
  const employee=label(root,'Synthetic employee');
  await employee.waitFor();
  await f.select(root,'Synthetic employee','sample-staff-employee-a');
  const edition=root.locator('select[name="edition"]');
  assert.equal(await edition.locator('option').count(),1);
  await f.select(root,'Exact published edition',{label:title+' · version 1'});
  await f.click(root,'Assign published policy','Author assigned a published edition',()=>seen(root,'sample-staff-employee-a · Pending'));
  const page=await f.activateLink(admin,root,'Open synthetic employee portal','/employee');
  const code='Synthetic employee code';
  await f.fill(page,code,f.codes['employee-b']);
  await f.click(page,'View my assignments','Unassigned employee sees no policy',()=>seen(page,'You have no assigned policy editions.'));
  await f.absent(page,'button','Record acknowledgment');
  await f.click(page,'Clear access code','Code clears and regains focus',async()=>{
    await gone(page,'You have no assigned policy editions.');
    assert.equal(await label(page,code).evaluate(e=>e===document.activeElement),true);
  });
  await f.fill(page,code,f.codes['employee-a']);
  await f.click(page,'View my assignments','Only the assigned published title and exact text appear',async()=>{
    await h(page,title).waitFor();await seen(page,text);
  });
  const consent=label(page,'I acknowledge this exact fictional policy edition.');
  assert.equal(await consent.isChecked(),false);
  await f.click(page,'Record acknowledgment','Unchecked form does not record a receipt',async()=>{
    assert.equal(await consent.evaluate(e=>e.validity.valueMissing),true);
    assert.equal(await page.getByText(/^Acknowledged · receipt /).count(),0);
  });
  await f.check(page,'I acknowledge this exact fictional policy edition.');
  await f.click(page,'Record acknowledgment','Checked confirmation creates one receipt',()=>page.getByText(/^Acknowledged · receipt /).waitFor());
  const saved=await page.getByText(/^Acknowledged · receipt /).innerText();
  await f.absent(page,'button','Record acknowledgment');
  await f.click(page,'Clear access code','Policy and receipt hidden',()=>gone(page,saved));
  await f.fill(page,code,f.codes['employee-a']);
  await f.click(page,'View my assignments','Same durable receipt on reopening',()=>seen(page,saved));
  assert.doesNotMatch(await page.locator('#employee-list').innerText(),/Internal test reviewer|sample-staff-employee-/);
  await admin.reload();
  await f.click(admin,'Policy attestations','Operator sees acknowledgment state',()=>seen(root,'sample-staff-employee-a · Acknowledged'));
  f.finish();
});

test('browser portal: employee acknowledgments wait for the current assignment refresh',enabled,async t=>{
  const f=await fixture(t),titles=['First fictional policy','Second fictional policy'];
  for(const title of titles){
    const pin=await f.publishFixturePolicy(title,'Review this exact fictional edition.');
    await f.api('employee-attestations','analyst',{employee:'sample-staff-employee-a',...pin});
  }
  const page=await f.page('/employee'),portal=page.locator('#employee-list');
  const [first,second]=titles.map(title=>section(page,portal,title));
  const confirm='I acknowledge this exact fictional policy edition.',submit='Record acknowledgment';
  await f.fill(page,'Synthetic employee code',f.codes['employee-a']);
  await f.click(page,'View my assignments','Employee loaded both independent assignments',()=>h(second,titles[1]).waitFor());
  await f.check(first,confirm);
  await f.check(second,confirm);
  const saved=Promise.withResolvers(),deliver=Promise.withResolvers();
  await page.route('**/api/employee/attest',async route=>{
    try{
      const response=await route.fetch();
      assert.equal(response.status(),200);
      saved.resolve();
      await deliver.promise;
      await route.fulfill({response});
    }catch(error){saved.reject(error);}
  },{times:1});
  try{
    await b(first,submit).click();
    await saved.promise;
    assert.equal(await b(second,submit).isDisabled(),true);
    assert.equal(await b(page,'Clear access code').isEnabled(),true);
  }finally{deliver.resolve();}
  await seen(first,/^Acknowledged · receipt /);
  await f.check(second,confirm);
  await f.click(second,submit,'Second acknowledgment retained the first receipt',()=>seen(second,/^Acknowledged · receipt /));
  assert.equal(await portal.getByText(/^Acknowledged · receipt /).count(),2);
  f.finish();
});

test('browser portal: learner grant with no work cannot open peer training; assigned learner opens and clears',enabled,async t=>{
  const f=await fixture(t),title='Fictional restricted training',text='This policy is pinned to the training course.';
  const pin=await f.publishFixturePolicy('Fictional restricted policy',text);
  let data=await f.api('training/create','analyst',{title,template:'fictional-policy-practice-v1',...pin});
  const action=async (name,actor,fields={})=>{
    const [{id,revision}]=data.courses;
    data=await f.api('training/'+name,actor,{course:id,revision,...fields});
  };
  await action('submit','analyst');
  await action('publish','reviewer',{note:'Independent approval of the fictional exercise.'});
  await action('assign','analyst',{learner:'sample-learner-a'});
  const page=await f.page('/training'),code='Synthetic learner code',open='Open '+title;
  await f.fill(page,code,f.codes['learner-b']);
  await f.click(page,'View my assignments','Unassigned grant sees an empty list',()=>seen(page,'No training is assigned to this synthetic learner.'));
  await f.absent(page,'button',open);
  await f.click(page,'Clear learner access','Assignments hidden and code focused',async()=>{
    await gone(page,'No training is assigned to this synthetic learner.');
    assert.equal(await label(page,code).evaluate(e=>e===document.activeElement),true);
  });
  await f.fill(page,code,f.codes['learner-a']);
  await f.click(page,'View my assignments','Assigned grant sees only own training',()=>b(page,open).waitFor());
  await f.click(page,open,'Assigned learner gets the Start exercise control',()=>b(page,'Start exercise').waitFor());
  await f.disclosure(page,'Read assigned policy: Fictional restricted policy · edition 1');
  await seen(page,text);
  await f.click(page,'Clear learner access','Lesson cleared without starting',()=>gone(page,text));
  await f.absent(page,'button','Start exercise');
  await f.fill(page,code,f.codes['learner-b']);
  await f.click(page,'View my assignments','After switching grant, prior course still hidden',()=>seen(page,'No training is assigned to this synthetic learner.'));
  await f.absent(page,'button',open);
  assert.equal(await h(page,title).count(),0);
  await b(page,'Clear learner access').click();
  await f.fill(page,code,f.codes['learner-a']);
  await b(page,'View my assignments').click();
  await b(page,open).click();
  await b(page,'Start exercise').waitFor();
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  assert.equal(await label(page,code).isVisible(),true);
  assert.equal(await label(page,code).inputValue(),'');
  await f.absent(page,'button','Start exercise');
  f.finish();
});

test('browser portal: clearing a learner while a lesson is delayed allows immediate sign-in as another learner',enabled,async t=>{
  const f=await fixture(t),title='Fictional delayed training';
  const pin=await f.publishFixturePolicy('Fictional delayed policy','This fictional lesson is held briefly by the test.');
  let data=await f.api('training/create','analyst',{title,template:'fictional-policy-practice-v1',...pin});
  const action=async (name,actor,fields={})=>{
    const [{id,revision}]=data.courses;
    data=await f.api('training/'+name,actor,{course:id,revision,...fields});
  };
  await action('submit','analyst');
  await action('publish','reviewer',{note:'Independent approval of the delayed fictional exercise.'});
  await action('assign','analyst',{learner:'sample-learner-a'});

  const page=await f.page('/training'),code='Synthetic learner code',open='Open '+title;
  const ready=Promise.withResolvers(),release=Promise.withResolvers(),finished=Promise.withResolvers();
  t.after(()=>release.resolve());
  await page.route('**/api/training-learner/lesson',async route=>{
    try{
      const response=await route.fetch();
      assert.equal(response.status(),200);
      ready.resolve();
      await release.promise;
      await route.fulfill({response}).catch(()=>{}); // Clearing access may cancel the request.
    }catch(error){ready.reject(error);}
    finally{finished.resolve();}
  });

  await f.fill(page,code,f.codes['learner-a']);
  await f.click(page,'View my assignments','Assigned learner sees the fictional training',()=>b(page,open).waitFor());
  await b(page,open).click();
  await ready.promise;
  try{
    await f.click(page,'Clear learner access','Prior course disappears while its response is outstanding',()=>gone(page,title));
    await f.fill(page,code,f.codes['learner-b']);
    await f.click(page,'View my assignments','The next learner can sign in before the previous request finishes',()=>
      seen(page,'No training is assigned to this synthetic learner.'));
  }finally{
    release.resolve();
  }
  await finished.promise;
  await f.absent(page,'button',open);
  await f.absent(page,'button','Start exercise');
  f.finish();
});

test('browser portal: separately reviewed trust center drafts, local publication, replacement and withdrawal',enabled,async t=>{
  const f=await fixture(t),author=await f.operator('analyst','Trust center'),reviewer=await f.operator('reviewer');
  const a=author.locator('#trust-center-view'),r=reviewer.locator('#trust-center-view');
  const title='Privacy practices',privateCopy='Changes to fictional information handling are documented and reviewed in the sample workbench.';
  const firstChoice='This fictional service keeps a local inventory of the information used by its sample operations.';
  const returnNote='Internal hypothetical clarification only.';
  const withdraw='Internal fictional withdrawal only.';
  const aRow=section(author,a,title),rRow=section(reviewer,r,title);
  const visitor=await f.activateLink(author,a,'Open local visitor preview','/trust-center/sample-qa');
  const guest=await f.page('/trust-center/sample-qa');
  const empty=()=>Promise.all([visitor,guest].map(async p=>{await p.reload();await seen(p,'No published cards yet.');}));
  await Promise.all([visitor,guest].map(p=>seen(p,'No published cards yet.')));
  await f.select(aRow,'Bundled fictional copy','overview');
  await f.click(aRow,'Draft new version','First draft is private',()=>seen(aRow,'Latest version 1 · draft'));
  await seen(aRow,firstChoice);
  await empty();
  await f.click(aRow,'Send for review','Draft awaiting independent review',()=>seen(aRow,'Latest version 1 · in-review'));
  await f.absent(aRow,'button','Approve this version');
  await f.absent(aRow,'button','Publish approved version to local preview');
  await f.click(reviewer,'Trust center','Reviewer sees exact submitted version',()=>seen(rRow,'Latest version 1 · in-review'));
  await f.fill(rRow,'Internal fictional note',returnNote);
  await f.click(rRow,'Return this version','Reviewer returned v1 with internal note',()=>seen(rRow,'Latest version 1 · returned'));
  await seen(rRow,'Internal review note: '+returnNote);
  await empty();
  await author.reload();
  await f.click(author,'Trust center','Author sees returned version',()=>seen(aRow,'Latest version 1 · returned'));
  await f.select(aRow,'Bundled fictional copy','review');
  await f.click(aRow,'Draft new version','Second bundled option is a new version',()=>seen(aRow,'Latest version 2 · draft'));
  await f.click(aRow,'Send for review','Second exact version submitted',()=>seen(aRow,'Latest version 2 · in-review'));
  await reviewer.reload();
  await f.click(reviewer,'Trust center','Reviewer sees submitted v2',()=>seen(rRow,'Latest version 2 · in-review'));
  await f.click(rRow,'Approve this version','Reviewer approves but does not publish',()=>seen(rRow,'Latest version 2 · approved'));
  await f.absent(rRow,'button','Publish approved version to local preview');
  await empty();
  await author.reload();
  await f.click(author,'Trust center','Author sees independently approved v2',()=>seen(aRow,'Latest version 2 · approved'));
  await f.click(aRow,'Publish approved version to local preview','Visitor now sees v2 only',async()=>{
    await seen(aRow,'Visitor sees version 2.');
    for(const p of [visitor,guest]){
      await p.reload();
      await h(p,title).waitFor();
      await seen(p,privateCopy);
      await gone(p,firstChoice);await gone(p,returnNote);
    }
  });
  const history=await f.disclosure(aRow,'Version history');
  await seen(history,'Version 2 · published · '+privateCopy);
  await seen(history,'Version 1 · returned · '+firstChoice);
  async function projections(current,excluded){
    for(const p of [visitor,guest]){
      await p.reload();await h(p,title).waitFor();await seen(p,current);
      await gone(p,excluded);await gone(p,returnNote);
      assert.equal(await h(p,title).count(),1);
    }
  }
  await f.select(aRow,'Bundled fictional copy','overview');
  await f.click(aRow,'Draft new version','The active v2 remains published during draft v3',()=>seen(aRow,'Latest version 3 · draft'));
  await projections(privateCopy,firstChoice);
  await f.click(aRow,'Send for review','Exact replacement is in review without exposing its copy',()=>seen(aRow,'Latest version 3 · in-review'));
  await reviewer.reload();
  await f.click(reviewer,'Trust center','Independent reviewer sees the replacement candidate',()=>seen(rRow,'Latest version 3 · in-review'));
  await f.click(rRow,'Approve this version','Independent approval does not replace existing visitor copy',()=>seen(rRow,'Latest version 3 · approved'));
  await projections(privateCopy,firstChoice);
  await author.reload();
  await f.click(author,'Trust center','Author sees v3 independently approved',()=>seen(aRow,'Latest version 3 · approved'));
  await f.click(aRow,'Publish approved version to local preview','Published v3 replaces v2 without duplicates',async()=>{
    await seen(aRow,'Visitor sees version 3.');
    await projections(firstChoice,privateCopy);
  });
  const replacements=await f.disclosure(aRow,'Version history');
  await seen(replacements,'Version 3 · published · '+firstChoice);
  await seen(replacements,'Version 2 · superseded · '+privateCopy);
  await f.fill(aRow,'Internal fictional note',withdraw);
  await f.click(aRow,'Withdraw active version','Withdrawal leaves nothing and does not revive superseded v2',async()=>{
    await seen(aRow,'Latest version 3 · withdrawn');
    await empty();
    await gone(visitor,firstChoice);await gone(visitor,privateCopy);await gone(visitor,withdraw);
  });
  await f.absent(aRow,'button','Withdraw active version');
  await f.absent(aRow,'button','Publish approved version to local preview');
  f.finish();
});

test('browser inventory: typed record/link lifecycle, stale reload, scoped lineage, and map export',enabled,async t=>{
  const f=await fixture(t),page=await f.operator('analyst','Data mapping');
  const root=page.locator('#data-map-view'),host='Fictional QA host',dataset='Fictional QA data',updated='Fictional QA records';
  const map='data-map',node=(type,name,expectedRevision)=>({type,name,owner:'Fixture owner',detail:'Fixture detail',expectedRevision});
  // Create in another authorized session to exercise the real stale edit/reload path.
  await h(root,'Data mapping and lineage').waitFor();
  let add=await f.disclosure(root,'Add inventory record');
  await f.select(add,'Record type','dataset');
  await f.fill(add,'Fictional name',dataset);
  await f.fill(add,'Fictional owner','Fixture owner');
  await f.fill(add,'Fictional data categories','Example dataset categories only.');
  const hostId=(await f.api(map+'/nodes','analyst',node('system',host,0))).nodes[0].id;
  await f.click(add,'Add inventory record','Stale form rejected, real reload button offered',()=>b(page,'Reload map').waitFor());
  await f.click(page,'Reload map','Fresh graph includes separately created host',()=>h(root,host).waitFor());
  add=await f.disclosure(root,'Add inventory record');
  await f.select(add,'Record type','dataset');
  await f.fill(add,'Fictional name',dataset);
  await f.fill(add,'Fictional owner','Fixture owner');
  await f.fill(add,'Fictional data categories','Example dataset categories only.');
  await f.click(add,'Add inventory record','Typed dataset added',()=>h(root,dataset).waitFor());
  const datasetId=(await f.api(map,'analyst')).nodes.find(n=>n.name===dataset).id;
  const datasetRow=article(page,root,dataset),hostRow=article(page,root,host);
  const edit=await f.disclosure(datasetRow,'Edit inventory record');
  await f.fill(edit,'Fictional name',updated);
  const revised=article(page,root,updated);
  await f.click(edit,'Save inventory record','Record renamed without changing identity',async()=>{
    await h(revised,updated).waitFor();
    await seen(revised,'Record ID: '+datasetId);
  });
  const addLink=await f.disclosure(root,'Add directed link');
  await f.select(addLink,'Link type','reads');
  assert.equal(await label(addLink,'To').locator('option').count(),1);
  await f.select(addLink,'Link type','hosts');
  await f.select(addLink,'From',hostId);
  await f.select(addLink,'To',datasetId);
  await f.fill(addLink,'Fictional flow purpose','Synthetic hosting relationship.');
  const flow=article(page,root,host+' → '+updated);
  await f.click(addLink,'Add directed link','System hosts the dataset',()=>seen(flow,'Synthetic hosting relationship.'));
  const lineage=root.locator('#lineage-output');
  await f.click(hostRow,'Inspect lineage for '+host,'Downstream includes the linked dataset',()=>seen(lineage,updated+' (Dataset)'));
  await f.absent(revised,'button','Archive inventory record');
  assert.equal(await revised.locator('summary').filter({hasText:'Archive inventory record'}).count(),0);
  const archiveLink=await f.disclosure(flow,'Archive link');
  await f.fill(archiveLink,'Archive rationale','Synthetic host mapping replaced.');
  await f.click(archiveLink,'Archive link','Link visibly archived and lineage no longer contains dataset',async()=>{
    await seen(flow,'Hosts · archived');
    await gone(lineage,updated+' (Dataset)');
  });
  await f.absent(flow,'button','Archive link');
  const archive=await f.disclosure(revised,'Archive inventory record');
  await f.fill(archive,'Archive rationale','Fictional dataset no longer active.');
  await f.click(archive,'Archive inventory record','Unlinked inventory record archived',()=>seen(revised,'Dataset · archived'));
  assert.equal(await revised.locator('summary').filter({hasText:'Edit inventory record'}).count(),0);
  const payload=JSON.parse(await f.download(page,root,'Export map JSON'));
  assert.ok(payload.graph.nodes.find(n=>n.id===datasetId).archivedAt);
  assert.ok(payload.graph.links.find(n=>n.fromId===hostId&&n.toId===datasetId).archivedAt);
  const reviewer=await f.operator('reviewer','Data mapping'),r=reviewer.locator('#data-map-view');
  await seen(r,'Dataset · archived');
  await f.absent(r,'button','Add inventory record');
  assert.equal(await r.locator('summary').filter({hasText:'Add directed link'}).count(),0);
  await f.click(r,'Inspect lineage for '+updated,'Reviewer can inspect the archived record read-only',()=>h(r,'Lineage for '+updated).waitFor());
  f.finish();
});

test('browser dictionary: typed discovery consumer, return, immutable pin through next approval, detach and retire',enabled,async t=>{
  const f=await fixture(t),author=await f.operator('analyst','Data mapping'),reviewer=await f.operator('reviewer');
  const map=author.locator('#data-map-view'),dictionary=author.locator('#dictionary-view'),r=reviewer.locator('#dictionary-view');
  const dataset='Fictional Seed Index',first='Fictional restricted term',second='Fictional revised term',third='Fictional final term';
  const base='Fictional definition one.',returned='Clarify the fictional definition.';
  await f.click(map,'Choose synthetic fixture','Built-in schema selectors are visible',()=>label(map,'Bundled fixture').waitFor());
  await f.select(map,'Bundled fixture','sample-garden:1');
  await f.click(map,'Preview synthetic import','Review lists candidate record before application',()=>h(map,dataset).waitFor());
  await f.click(map,'Apply reviewed import','Bundled schema imports one host and one dataset',()=>seen(author,'Imported: 2 new records, 0 schema updates, 1 links.'));
  await f.click(author,'Data dictionary','Dictionary pane opened',()=>h(dictionary,'Governed data dictionary').waitFor());
  const create=await f.disclosure(dictionary,'Draft a term');
  await f.select(create,'Term type','sensitivity');
  await f.fill(create,'Stable slug','sample-sensitivity');
  await f.fill(create,'Fictional title',first);
  await f.fill(create,'Fictional definition',base);
  const a1=article(author,dictionary,first),a2=article(author,dictionary,second),a3=article(author,dictionary,third);
  const r1=article(reviewer,r,first),r2=article(reviewer,r,second),r3=article(reviewer,r,third);
  await f.click(create,'Create term draft','New typed term starts in draft',()=>seen(a1,'Latest version 1 · draft'));
  await f.absent(a1,'button','Pin approved version');
  async function submit(row,version,pinned){
    await f.click(row,'Submit version','Exact v'+version+' queued for review',()=>seen(row,'Latest version '+version+' · review'+(pinned?' · approved version '+pinned:'')));
  }
  async function reloadReview(row,version,pinned){
    await reviewer.reload();
    await f.click(reviewer,'Data dictionary','Independent reviewer sees submitted v'+version,()=>seen(row,'Latest version '+version+' · review'+(pinned?' · approved version '+pinned:'')));
  }
  async function reloadAuthor(row,status){
    await author.reload();
    await f.click(author,'Data dictionary','Analyst sees version status '+status,()=>seen(row,status));
  }
  await submit(a1,1);
  await reloadReview(r1,1);
  await f.click(r1,'Approve version','First version approved independently',()=>seen(r1,'Latest version 1 · approved · approved version 1'));
  await reloadAuthor(a1,'Latest version 1 · approved · approved version 1');
  const options=await label(a1,'Inventory consumer').locator('option').allTextContents();
  assert.deepEqual(options,[dataset],'Sensitivity terms can only select datasets, not the imported host');
  await f.select(a1,'Inventory consumer',{label:dataset});
  await f.click(a1,'Pin approved version','Dataset pinned to v1',()=>begins(a1,dataset+' · pinned version 1'));
  await f.absent(a1,'button','Retire term');
  async function draft(row,title,def,target,expected){
    const form=await f.disclosure(row,'Draft next version');
    await f.fill(form,'Fictional title',title);
    await f.fill(form,'Fictional definition',def);
    await f.click(form,'Create next draft','New draft preserves old version pin',async()=>{
      await seen(target,expected);await begins(target,dataset+' · pinned version 1');
    });
  }
  await draft(a1,second,'Needs refinement.',a2,'Latest version 2 · draft · approved version 1');
  await submit(a2,2,1);
  await reloadReview(r2,2,1);
  await f.fill(r2,'Return reason',returned);
  await f.click(r2,'Return version','Reviewer returns exact v2',()=>seen(r2,'Latest version 2 · returned · approved version 1'));
  await seen(await f.disclosure(r2,'Version history'),'Internal return reason: '+returned);
  await reloadAuthor(a2,'Latest version 2 · returned · approved version 1');
  await draft(a2,third,'Separate independently reviewed revision.',a3,'Latest version 3 · draft · approved version 1');
  await submit(a3,3,1);
  await reloadReview(r3,3,1);
  await f.click(r3,'Approve version','v3 approved without re-pinning v1 consumer',async()=>{
    await seen(r3,'Latest version 3 · approved · approved version 3');
    await seen(r3,dataset+' · pinned version 1');
  });
  await f.absent(r3,'button','Detach '+dataset);
  await reloadAuthor(a3,'Latest version 3 · approved · approved version 3');
  await f.click(author,'Data mapping','Inventory still presents original version title/link',()=>seen(map,first+' · sample-sensitivity version 1'));
  await f.click(author,'Data dictionary','Pinned consumer ready to detach',()=>b(a3,'Detach '+dataset).waitFor());
  await f.click(a3,'Detach '+dataset,'Explicit detach removes consumer and enables retirement',async()=>{
    await seen(a3,'No active inventory references.');
    await b(a3,'Retire term').waitFor();
  });
  await f.fill(a3,'Retirement reason','Fictional category no longer needed.');
  await f.click(a3,'Retire term','Retired entry remains readable without attach or revise',()=>seen(a3,'sample-sensitivity · Sensitivity · retired'));
  await f.absent(a3,'button','Pin approved version');
  assert.equal(await a3.locator('summary').filter({hasText:'Draft next version'}).count(),0);
  const payload=JSON.parse(await f.download(author,dictionary,'Export dictionary JSON'));
  const term=payload.dictionary.terms.find(x=>x.slug==='sample-sensitivity');
  assert.deepEqual(term.versions.map(v=>v.status),['approved','returned','approved']);
  assert.ok(term.retiredAt);
  assert.deepEqual(term.consumers,[]);
  f.finish();
});

test('browser documents: owned case evidence, reviewer actions and version-bound mixed-format downloads',enabled,async t=>{
  const f=await fixture(t),first='Fictional case evidence edition one',second='Fictional case evidence edition two';
  const draftCopy='Fictional evidence edition one, linked to assigned rights case.';
  const revisedCopy='Fictional evidence edition two, retaining the original case link.';
  const rows=await f.api('rights/cases','analyst',{kind:'access',owner:'case-operator',days:7,note:'Fictional QA case to link.'});
  const own=rows.cases.find(x=>x.owner==='case-operator');
  const privateRows=await f.api('rights/cases','analyst',{kind:'correction',owner:'analyst',days:7,note:'Separate fictional case.'});
  const other=privateRows.cases.find(x=>x.owner==='analyst');
  const rootPath='governance-documents/records';
  const {documents:[doc]}=await f.api(rootPath,'analyst',{kind:'evidence',title:'Other owner evidence',content:'Fictional separate case record.',links:[{type:'rights-case',id:other.id}],expectedRevision:0});
  const edition=doc.revisions[0],revision=rootPath+'/'+doc.id+'/revisions/'+edition.id;
  await f.api(revision+'/submit','analyst',{expectedRevision:1});
  await f.api(revision+'/publish','reviewer',{expectedRevision:2,note:'Fictional other-owner approval.'});
  const author=await f.operator('analyst','Policies and documents'),reviewer=await f.operator('reviewer'),staff=await f.operator('case-operator','Policies and documents');
  const a=author.locator('#governance-docs-view'),r=reviewer.locator('#governance-docs-view'),s=staff.locator('#governance-docs-view');
  await seen(s,'No documents are visible to this demo identity.');
  const c1=revisionCard(author,a,first),c2=revisionCard(author,a,second),r1=revisionCard(reviewer,r,first),r2=revisionCard(reviewer,r,second);
  const s1=revisionCard(staff,s,first),s2=revisionCard(staff,s,second);
  const create=await f.disclosure(a,'Draft a document');
  await f.select(create,'Document type','evidence');
  await f.fill(create,'Fictional title',first);
  await f.fill(create,'Original fictional text',draftCopy);
  await f.select(create,'Linked fictional records','rights-case:'+own.id);
  await f.click(create,'Create document draft','New evidence linked to the selected case',async()=>{await h(c1,first).waitFor();const text=await c1.innerText();assert.ok(text.includes('Rights case:')&&text.includes(own.id.slice(0,8)),text);});
  const csv=Buffer.from('name,status\nFictional evidence,reviewed\n');
  const txt=Buffer.from('Fictional edition-two attachment.\n');
  async function upload(row,filename,mimeType,content){
    await f.file(row,'Fictional attachments',filename,mimeType,content);
    await f.click(row,'Upload attachments','Attachment belongs to exact draft revision',()=>b(row,'Download attachment '+filename).waitFor());
  }
  async function handoff(row,reviewRow,who,title){
    await f.click(row,'Submit for review','Draft locked for review',()=>seen(row,'review'));
    await f.absent(row,'button','Upload attachments');
    await reviewer.reload();
    await f.click(reviewer,'Policies and documents','Reviewer sees submitted evidence',()=>seen(reviewRow,'review'));
    await f.absent(reviewRow,'button','Remove attachment '+who);
    const approve=await f.disclosure(reviewRow,'Publish locally');
    await f.fill(approve,'Fictional review rationale','Compared '+title+' against the fictional case.');
    await f.click(approve,'Publish locally','Independent approval publishes this exact revision',()=>seen(reviewRow,'Current'));
  }
  await upload(c1,'evidence.csv','text/csv',csv);
  await staff.reload();
  await f.click(staff,'Policies and documents','Case owner cannot see own draft or other case publication',()=>seen(s,'No documents are visible to this demo identity.'));
  await handoff(c1,r1,'evidence.csv','edition one');
  await staff.reload();
  await f.click(staff,'Policies and documents','Case owner sees own evidence only after publication',()=>seen(s1,'Current'));
  await f.absent(s,'heading','Other owner evidence');
  await f.absent(s1,'button','Upload attachments');
  assert.deepEqual(await f.download(staff,s1,'Download attachment evidence.csv','button','evidence.csv'),csv);
  await author.reload();
  await f.click(author,'Policies and documents','First evidence is current before next draft',()=>seen(c1,'Current'));
  const dossier=a.locator('article').filter({has:h(author,first)});
  const next=await f.disclosure(dossier,'Draft next revision');
  await f.fill(next,'Fictional title',second);
  await f.fill(next,'Original fictional text',revisedCopy);
  await f.select(next,'Linked fictional records','rights-case:'+own.id);
  await f.click(next,'Create next revision','New evidence draft leaves first revision current',async()=>{
    await seen(c2,'draft');await seen(c1,'Current');await seen(c2,'No attachments.');
  });
  await upload(c2,'evidence.txt','text/plain',txt);
  await handoff(c2,r2,'evidence.txt','edition two');
  await staff.reload();
  await f.click(staff,'Policies and documents','Owner sees distinctly current and superseded editions',async()=>{
    await seen(s1,'Superseded');await seen(s2,'Current');
  });
  await f.click(s1,'View fictional text','Superseded exact body still readable',()=>seen(s1,draftCopy));
  await f.click(s2,'View fictional text','Current exact body differs',()=>seen(s2,revisedCopy));
  assert.deepEqual(await f.download(staff,s1,'Download attachment evidence.csv','button','evidence.csv'),csv);
  assert.deepEqual(await f.download(staff,s2,'Download attachment evidence.txt','button','evidence.txt'),txt);
  await f.absent(s1,'button','Download attachment evidence.txt');
  await f.absent(s2,'button','Download attachment evidence.csv');
  await f.absent(s,'heading','Other owner evidence');
  f.finish();
});

for (const profile of [
  {portal:'requester',input:'Synthetic access code',button:'Check my request',api:'requester/status',oldText:'Received',
    nextText:'No request submitted',async prepare(f,page){
      await f.fill(page,this.input,f.codes['requester-a']);
      await f.click(page,this.button,'First requester code initially has no request',()=>seen(page,'No request submitted'));
      await f.click(page,'Submit synthetic request','First requester has a distinguishable response',()=>seen(page,this.oldText));
      await b(page,'Clear access code').click();
    }},
  {portal:'employee',input:'Synthetic employee code',button:'View my assignments',api:'employee/assignments',
    oldText:'Fictional policy only for first employee',nextText:'You have no assigned policy editions.',async prepare(f){
      const pin=await f.publishFixturePolicy(this.oldText,'A fictional exact edition.');
      await f.api('employee-attestations','analyst',{employee:'sample-staff-employee-a',...pin});
    }}
]){
  test('browser portal: '+profile.portal+' can start new access while a cleared access response is delayed',enabled,async t=>{
    const f=await fixture(t),page=await f.page('/'+profile.portal);
    await profile.prepare(f,page);
    const first=f.codes[profile.portal+'-a'],next=f.codes[profile.portal+'-b'];
    const ready=Promise.withResolvers(),release=Promise.withResolvers(),finished=Promise.withResolvers();
    t.after(()=>release.resolve());
    await page.route('**/api/'+profile.api,async route=>{
      if(route.request().postDataJSON().code!==first)return route.continue();
      try{
        const response=await route.fetch();
        assert.equal(response.status(),200);
        ready.resolve();
        await release.promise;
        await route.fulfill({response});
      }catch(error){ready.reject(error);}
      finally{finished.resolve();}
    });
    const field=label(page,profile.input);
    await f.fill(page,profile.input,first);
    await b(page,profile.button).click();
    await ready.promise;
    try{
      await f.click(page,'Clear access code','Clear returns focus and enables the primary control immediately',async()=>{
        assert.equal(await field.evaluate(e=>e===document.activeElement),true);
        assert.equal(await b(page,profile.button).isEnabled(),true);
      });
      await f.fill(page,profile.input,next);
      await f.click(page,profile.button,'New authorized access completes while the old response waits',()=>seen(page,profile.nextText));
      await field.focus();
      const oldResponse=page.waitForResponse(response=>response.url().endsWith('/api/'+profile.api)&&
        response.request().postDataJSON().code===first);
      release.resolve();
      await oldResponse;
      await finished.promise;
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await seen(page,profile.nextText);
      await gone(page,profile.oldText);
      assert.equal(await field.evaluate(e=>e===document.activeElement),true);
    }finally{release.resolve();}
    f.finish();
  });
}
