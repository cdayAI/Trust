'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const endpoint='/api/ethics/cases',scope='harbor';
const title='ETH-0001 · Gifts and hospitality';
const queue='Independent synthetic review queue';
const noReview='No case has been submitted for independent review.';
const button=(where,name)=>where.getByRole('button',{name,exact:true});
const heading=(where,name)=>where.getByRole('heading',{name,exact:true});
const text=(where,value)=>where.getByText(value,{exact:true});
const article=page=>page.locator('#ethics-view article');
const label=(where,name)=>where.getByLabel(name);
const reload=page=>button(page,'Reload ethics cases');

async function launched(t){
  const root=await mkdtemp(join(tmpdir(),'mvw-composed-ethics-'));
  const child=spawn(process.execPath,[resolve(__dirname,'../start-release.js')],{
    cwd:root,env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},stdio:['ignore','pipe','pipe'],
  });
  let output='',stderr='',timer;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
  const closed=new Promise((ready,fail)=>{child.once('error',fail);child.once('close',ready);});
  closed.catch(()=>{});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    try{await closed;}finally{await rm(root,{recursive:true,force:true,maxRetries:2});}
  });
  const ready=await Promise.race([
    new Promise((ok,fail)=>child.stdout.on('data',chunk=>{
      output+=chunk;if(output.includes('\n')){try{ok(JSON.parse(output.trim()));}catch(error){fail(error);}}
    })),
    closed.then(()=>{throw Error('Local release did not start: '+stderr);}),
    new Promise((_,fail)=>{timer=setTimeout(()=>fail(Error('Local release start timed out.')),20000);}),
  ]).finally(()=>clearTimeout(timer));
  assert.equal(ready.status,'ready');
  assert.match(ready.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const privatePath=relative(root,ready.accessFile);
  assert.ok(privatePath&&!privatePath.startsWith('..')&&!isAbsolute(privatePath));
  const access=JSON.parse(await readFile(ready.accessFile,'utf8'));
  assert.equal(access.mode,'local-synthetic-only');
  return {url:ready.url,access};
}
async function active(node){
  await node.waitFor();
  assert.equal(await node.evaluate(element=>element===document.activeElement),true);
}
async function scoped(page,path,workspace,body){
  return page.evaluate(async({path,workspace,body})=>{
    const url=new URL(path,location.origin);
    if(workspace)url.searchParams.set('workspace',workspace);
    const response=await fetch(url,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    return {status:response.status,json:await response.json()};
  },{path,workspace,body});
}
test('composed Chromium Ethics: stale returned and resubmitted decisions stay private and recover with keyboard focus',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:55000,
},async t=>{
  const f=await launched(t),{chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const trace=[],external=[],errors=[];
    async function pageFor(role,workspace=scope){
      const page=await browser.newPage({viewport:{width:1360,height:900},reducedMotion:'reduce',acceptDownloads:true});
      page.setDefaultTimeout(7000);
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{
        const target=new URL(request.url());
        if(target.pathname.startsWith(endpoint)&&request.method()==='POST')trace.push([target.pathname,request.postDataJSON()]);
      });
      await page.route('**/*',route=>{
        const {origin}=new URL(route.request().url());
        if(origin!==f.url){external.push(origin);return route.abort();}
        return route.continue();
      });
      await page.goto(f.url);
      if(role){
        const seat=f.access.staff.find(x=>x.memberships[workspace]===role);
        assert.ok(seat);
        await label(page,'Test account').fill(seat.id);
        await label(page,'Workspace ID').fill(workspace);
        await label(page,'Local access code').fill(seat.code);
        const [login]=await Promise.all([
          page.waitForResponse(response=>new URL(response.url()).pathname==='/api/session/login'),
          button(page,'Sign in').press('Enter'),
        ]);
        assert.equal(login.status(),200);
        if(role.startsWith('ethics-'))await heading(page,'Synthetic ethics case management').waitFor();
        else await button(page,'Privacy rights').waitFor();
      }
      return page;
    }
    async function action(page,name,path,status=200){
      const [wire]=await Promise.all([
        page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST'),
        button(page,name).press('Enter'),
      ]);
      assert.equal(wire.status(),status,path);
      const target=new URL(wire.url());
      assert.equal(target.searchParams.get('workspace'),scope);
      return {body:wire.request().postDataJSON(),model:await wire.json()};
    }
    const investigator=await pageFor('ethics-investigator');
    await label(investigator,'Fictional report category').selectOption('gift');
    await label(investigator,'Fictional intake priority').selectOption('routine');
    const opened=await action(investigator,'Open synthetic case',endpoint);
    assert.deepEqual(opened.body,{category:'gift',urgency:'routine'});
    const id=opened.model.case.id,path=endpoint+'/'+id;
    await heading(investigator,title).waitFor();
    await label(investigator,'Review path').selectOption('standard');
    await action(investigator,'Save triage',path+'/triage');
    await action(investigator,'Begin investigation',path+'/begin');
    async function findings(outcome,basis,disposition){
      await label(investigator,'Finding outcome').selectOption(outcome);
      await label(investigator,'Synthetic evidence basis').selectOption(basis);
      await action(investigator,'Record finding version',path+'/finding');
      await label(investigator,'Proposed disposition').selectOption(disposition);
      return action(investigator,'Submit for closure review',path+'/submit');
    }
    const first=await findings('inconclusive','no_fixture','unresolved');
    assert.equal(first.model.case.revision,5);
    const decider=await pageFor('ethics-reviewer'),missing=await pageFor('ethics-reviewer'),stale=await pageFor('ethics-reviewer');
    for(const page of [decider,missing,stale])await text(article(page),'Closure review · Routine · Revision 5').waitFor();

    await label(decider,'Return reason').selectOption('evidence');
    const sentBack=await action(decider,'Return for revision',path+'/return');
    assert.deepEqual(sentBack.body,{reason:'evidence',expectedRevision:5});
    await text(decider,noReview).waitFor();
    const old=await action(missing,'Approve synthetic closure',path+'/close',404);
    assert.deepEqual(old.body,{expectedRevision:5});
    await missing.locator('#notice').getByText(/Synthetic case not found\./).waitFor();
    assert.equal(await reload(missing).count(),1,'A return-induced 404 must offer a focused read-only reload.');
    await active(reload(missing));
    assert.equal(await button(missing,'Approve synthetic closure').count(),0);
    assert.equal(await text(missing,'Proposed disposition: Record unresolved synthetic review').count(),0);
    await reload(missing).press('Enter');
    await text(missing,noReview).waitFor();
    await active(heading(missing,queue));
    await active(heading(decider,queue));

    const ordinary=await pageFor('reviewer');
    assert.equal(await button(ordinary,'Ethics cases').isVisible(),false);
    assert.equal((await scoped(ordinary,endpoint,scope)).status,403);
    assert.equal((await scoped(ordinary,path+'/close',scope,{expectedRevision:6})).status,403);
    assert.doesNotMatch(JSON.stringify((await scoped(ordinary,'/api/audit/export',scope)).json),/ETH-0001|ethics-reviewer|Gifts and hospitality/);
    const orchard=await pageFor('ethics-reviewer','orchard');
    await text(orchard,noReview).waitFor();
    const denied=await scoped(orchard,path+'/close','orchard',{expectedRevision:6});
    assert.deepEqual(denied,await scoped(orchard,endpoint+'/'+randomUUID()+'/close','orchard',{expectedRevision:6}));
    assert.deepEqual(denied,{status:404,json:old.model});
    assert.equal((await scoped(orchard,endpoint,scope)).status,403);
    assert.equal(await heading(orchard,title).count(),0);
    assert.deepEqual((await scoped(orchard,endpoint,'orchard')).json.cases,[]);

    await button(investigator,'Ethics cases').press('Enter');
    await text(investigator,'Investigation · Routine · Revision 6').waitFor();
    assert.equal(await button(investigator,'Submit for closure review').count(),0);
    const newest=await findings('supported','fixture_review','remediation');
    assert.deepEqual(newest.body,{disposition:'remediation',expectedRevision:7,findingVersion:2});
    const refused=await action(stale,'Approve synthetic closure',path+'/close',409);
    assert.deepEqual(refused.body,{expectedRevision:5});
    assert.equal(refused.model.code,'ETHICS_REVISION_CONFLICT');
    await active(reload(stale));
    assert.equal(await button(stale,'Approve synthetic closure').count(),0);
    await reload(stale).press('Enter');
    await text(article(stale),'Closure review · Routine · Revision 8').waitFor();
    await active(heading(stale,title));

    // Make only the follow-up GET fail; the actual closure POST still commits.
    await stale.route(url=>url.pathname===endpoint&&url.searchParams.get('workspace')===scope,async route=>{
      if(route.request().method()==='GET')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic refresh unavailable."}'});
      return route.fallback();
    },{times:1});
    const closed=await action(stale,'Approve synthetic closure',path+'/close');
    assert.deepEqual(closed.body,{expectedRevision:8});
    assert.equal(closed.model.case.revision,9);
    await stale.locator('#notice').getByText(/The change was saved, but the current ethics cases could not be loaded\./).waitFor();
    await active(reload(stale));
    assert.equal(await text(stale,'Synthetic case closed.').count(),0);
    assert.equal(await button(stale,'Approve synthetic closure').count(),0);
    const postsAtReload=trace.filter(([url])=>url===path+'/close').length;
    await reload(stale).press('Enter');
    await text(article(stale),'Closed · Routine · Revision 9').waitFor();
    await active(heading(stale,title));
    assert.equal(trace.filter(([url])=>url===path+'/close').length,postsAtReload);
    assert.equal(postsAtReload,5); // Stale 404/409, ordinary and Orchard denials, one successful decision.

    await text(article(stale),'Finding versions').press('Enter');
    await text(article(stale),'Version 1 · Inconclusive in fictional scenario · No corroborating synthetic fixture').waitFor();
    await text(article(stale),'Version 2 · Supported in fictional scenario · Review synthetic fixture').waitFor();
    await text(article(stale),'Review returns').press('Enter');
    await text(article(stale),'Version 1 · Add another synthetic evidence assessment').waitFor();
    await text(article(stale),'Case activity').press('Enter');
    const timeline=article(stale).getByRole('listitem');
    assert.deepEqual((await timeline.allTextContents()).map(line=>line.split(' · ').slice(0,3).join(' · ')),[
      'opened · ethics-investigator · Revision 1','triage · ethics-investigator · Revision 2',
      'begin · ethics-investigator · Revision 3','finding · ethics-investigator · Revision 4',
      'submit · ethics-investigator · Revision 5','return · ethics-reviewer · Revision 6',
      'finding · ethics-investigator · Revision 7','submit · ethics-investigator · Revision 8',
      'close · ethics-reviewer · Revision 9',
    ]);
    const [file]=await Promise.all([
      stale.waitForEvent('download'),article(stale).getByRole('link',{name:'Download redacted summary',exact:true}).press('Enter'),
    ]);
    assert.equal(file.suggestedFilename(),'synthetic-ethics-summary.json');
    const summary=JSON.parse(await readFile(await file.path(),'utf8'));
    const {closedDay,activity,...facts}=summary;
    assert.deepEqual(facts,{schemaVersion:1,mode:'synthetic-ethics-redacted',caseReference:'ETH-0001',
      category:'gift',urgency:'routine',disposition:'remediation',findingOutcome:'supported',findingVersion:2});
    assert.match(closedDay,/^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(activity.map(row=>[row.action,row.role,row.revision]),closed.model.case.timeline.map(row=>[row.action,row.role,row.revision]));
    assert.ok(activity.every(row=>Object.keys(row).sort().join(',')==='action,day,revision,role'));
    assert.doesNotMatch(JSON.stringify(summary),new RegExp(id+'|sample-|fixture_review|evidence|proposal|returns|owner'));

    const requester=await pageFor();
    await requester.goto(f.url+'/requester');
    const code=f.access.requesters.find(row=>row.workspace===scope).code;
    await label(requester,'Synthetic access code').fill(code);
    await button(requester,'Check my request').press('Enter');
    await heading(requester,'No request submitted').waitFor();
    assert.equal(await button(requester,'View approved fictional result').count(),0);
    const result=await scoped(requester,'/api/requester/result',null,{code});
    assert.deepEqual(result,{status:200,json:{mode:'synthetic-requester-result',status:'not-available'}});
    assert.deepEqual(external,[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
