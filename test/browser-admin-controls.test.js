'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const enabled={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires installed Playwright and Chromium',timeout:45_000};
const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
const seen=(scope,name)=>scope.getByText(name,{exact:true}).waitFor();
const field=(scope,name)=>scope.getByLabel(name);
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

const mint=()=>randomBytes(32).toString('base64url');

async function fixture(t,{groups=false,oldClock=false}={}){
  const {chromium}=require('playwright');
  const root=await mkdtemp(join(tmpdir(),'mvw-ui-admin-'));
  const start=Date.now();
  const day=24*60*60_000;
  let now=oldClock?start-30*day+60_000:start;
  const accounts={
    'qa-admin':{north:'identity-admin'},'qa-other-admin':{south:'identity-admin'},
    'qa-author':{north:'analyst',south:'analyst'},'qa-reviewer':{north:'reviewer',south:'reviewer'},
    'qa-publisher':{north:'publisher'},'qa-case':{north:'case-operator'}
  };
  const codes=Object.fromEntries(Object.keys(accounts).map(id=>[id,mint()]));
  const applications=[
    {id:'sample-revoked',name:'Fictional revoked tool',summary:'A synthetic grant revoked by an administrator.'},
    {id:'sample-expiring',name:'Fictional expiring tool',summary:'A different synthetic grant that expires on schedule.'},
  ];
  const server=createServer({isolated:{
    root,now:()=>now,enableIdentityAdmin:true,
    workspaces:[{id:'north',label:'Synthetic North'},{id:'south',label:'Synthetic South'}],
    accounts:Object.keys(accounts).map(id=>({id,codeHash:codeHash(codes[id]),memberships:accounts[id]})),
    ...(groups?{groupApplications:[{workspace:'north',applications}]}:{})
  }}).listen(0,'127.0.0.1');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const interactions=[],observed=[],errors=[],external=[];
  async function page(){
    const ctx=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:980}});
    const p=await ctx.newPage();
    p.on('pageerror',e=>errors.push(e.message));
    p.setDefaultTimeout(6500);
    await ctx.route('**/*',route=>{
      if(new URL(route.request().url()).origin===url)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    await p.goto(url);
    return p;
  }
  async function click(scope,name,outcome,witness){
    await b(scope,name).click();await witness();interactions.push({control:name,outcome});
  }
  async function fill(scope,name,value){
    const control=field(scope,name);
    await control.fill(value);assert.equal(await control.inputValue(),value);
    interactions.push({control:name,outcome:'Entered synthetic value'});
  }
  async function select(scope,name,value,result){
    const control=field(scope,name);
    await control.selectOption(value);
    if(typeof value==='string')assert.equal(await control.inputValue(),value);
    else assert.equal(await control.locator('option:checked').innerText(),value.label);
    if(result)await result();
    interactions.push({control:name,outcome:'Selected '+(value.label||value)});
  }
  async function check(scope,name,checked=true){
    const box=scope.getByRole('checkbox',{name});
    await box.setChecked(checked);assert.equal(await box.isChecked(),checked);
    interactions.push({control:String(name),outcome:checked?'Checked':'Unchecked'});
  }
  async function disclose(scope,name){
    const selector=scope.locator('summary').filter({hasText:new RegExp('^'+escape(name)+'$')});
    await selector.click();assert.equal(await selector.evaluate(e=>e.parentElement.open),true);
    interactions.push({control:name,outcome:'Expanded'});
  }
  async function absent(scope,role,name){
    assert.equal(await scope.getByRole(role,{name,exact:true}).count(),0);
    observed.push({control:name,outcome:'Correctly unavailable under this role or state'});
  }
  async function nav(p,name,it){
    await click(p,name,'Opened '+name,()=>typeof it==='function'?it():h(p,name).first().waitFor());
  }
  async function signIn(p,id,workspace='north'){
    await fill(p,'Test account',id);await fill(p,'Workspace ID',workspace);await fill(p,'Local access code',codes[id]);
    await click(p,'Sign in','Verified '+id+' in '+workspace,()=>p.locator('#local-account').getByText(id+' · '+accounts[id][workspace],{exact:true}).waitFor());
  }
  async function operator(id,workspace){
    const p=await page();await signIn(p,id,workspace);return p;
  }
  async function download(page,scope,name,filename){
    const [file]=await Promise.all([page.waitForEvent('download'),scope.getByRole('link',{name,exact:true}).click()]);
    assert.equal(file.suggestedFilename(),filename);
    const parts=[];for await(const part of await file.createReadStream())parts.push(part);
    interactions.push({control:name,outcome:'Downloaded and inspected '+filename});
    return Buffer.concat(parts).toString();
  }
  async function http(route,{body,cookie,workspace='north',status=200}={}){
    const res=await fetch(url+'/api/'+route+(workspace?'?workspace='+workspace:''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})}
    });
    const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));
    return {data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  // Explicit server fixtures create only fictional state, not counted as browser actions.
  const httpLogin=async(id,workspace='north')=>(await http('session/login',{workspace:null,body:{account:id,workspace,code:codes[id]}})).cookie;
  return {page,operator,signIn,click,fill,select,check,disclose,absent,nav,download,http,httpLogin,
    clock:offset=>{now=start+offset;},
    finish(){assert.deepEqual(errors,[]);assert.deepEqual(external,[]);t.diagnostic(JSON.stringify({activated:interactions.length,observedOnly:observed.length,interactions,observed}));}
  };
}

test('browser workflow studio: publisher creates version, isolated reviewer returns, analyst resubmits, reviewer approves and exports',enabled,async t=>{
  const f=await fixture(t);
  const publisher=await f.operator('qa-publisher'),a=await f.operator('qa-author'),r=await f.operator('qa-reviewer');
  const pPane=publisher.locator('#workflow-studio-view'),aPane=a.locator('#workflow-studio-view'),rPane=r.locator('#workflow-studio-view');
  const recipe=(await f.http('workflows/studio',{cookie:await f.httpLogin('qa-publisher')})).data.recipes[0];
  const view='View '+recipe.id+' version 1',title='Fictional studio rework acceptance';
  await f.nav(publisher,'Workflow studio',()=>b(pPane,'Load '+recipe.label).waitFor());
  await f.click(pPane,'Load '+recipe.label,'Fictional recipe loads exact state and transitions',()=>field(pPane,'Initial state ID').waitFor());
  await f.fill(pPane,'Display name','Fictional staged review');
  const extraState=pPane.getByRole('group',{name:'States',exact:true}).locator(':scope > div').last();
  await f.click(pPane,'Add state','Draft editor inserts an extra state',async()=>assert.equal(await pPane.getByRole('group',{name:'States',exact:true}).locator(':scope > div').count(),recipe.states.length+1));
  await f.fill(extraState,'State ID','unused');
  await f.fill(extraState,'State label','Unused state');
  await f.click(extraState,'Remove state','Extra state removed before committing',async()=>assert.equal(await pPane.getByRole('group',{name:'States',exact:true}).locator(':scope > div').count(),recipe.states.length));
  const transitions=pPane.getByRole('group',{name:'Transitions',exact:true});
  await f.click(pPane,'Add transition','Draft editor can add a transition',async()=>assert.equal(await transitions.locator(':scope > div').count(),recipe.transitions.length+1));
  await f.click(transitions.locator(':scope > div').last(),'Remove transition','Unused extra transition removed',async()=>assert.equal(await transitions.locator(':scope > div').count(),recipe.transitions.length));
  await f.check(pPane,/Publish this exact immutable version/);
  await f.click(pPane,'Publish workflow version','Publisher sees immutable v1 published',()=>b(pPane,view).waitFor());
  await f.click(pPane,view,'Published version details list independent review',()=>pPane.getByText(/return-for-changes: awaiting-review.*independent/).waitFor());
  await f.click(pPane,'Use as next draft','Version 2 starts from the immutable version',()=>seen(pPane,'Expected current published version: 1'));
  assert.equal(await field(pPane,'Definition ID').evaluate(x=>x.readOnly),true);
  await f.fill(pPane,'Display name','Fictional staged review version two');
  await f.check(pPane,/Publish this exact immutable version/);
  await f.click(pPane,'Publish workflow version','Second version published without changing v1',()=>b(pPane,'View '+recipe.id+' version 2').waitFor());
  await f.nav(a,'Workflow studio',()=>seen(aPane,'Workspace role: initiator'));
  await f.select(aPane,'Published workflow version',recipe.id+':1');
  await f.fill(aPane,'Fictional instance title',title);
  await f.click(aPane,'Start pinned instance','Instance starts on v1, not latest v2',()=>seen(aPane,'Draft · '+recipe.id+' version 1 · revision 1'));
  await f.fill(aPane,'summary','A fictional initial description.');
  await f.click(aPane,'Run submit-for-review','Analyst submits v1',()=>seen(aPane,'Awaiting independent review · '+recipe.id+' version 1 · revision 2'));
  await f.absent(aPane,'button','Run approve');
  await f.absent(aPane,'link','Export full workflow audit JSON');
  async function open(p,pane,state,rev){
    await p.reload();
    await f.nav(p,'Workflow studio',()=>field(pane,'Open synthetic instance').waitFor());
    await f.select(pane,'Open synthetic instance',{label:title+' · '+state},()=>pane.getByText(new RegExp('version 1 · revision '+rev+'$')).waitFor());
  }
  await open(r,rPane,'awaiting-review',2);
  const returns=rPane.locator('article').filter({has:b(r,'Run return-for-changes')});
  await f.fill(returns,'reason','Clarify the fictional summary.');
  await f.click(returns,'Run return-for-changes','Independent reviewer returns to draft',()=>seen(rPane,'Draft · '+recipe.id+' version 1 · revision 3'));
  await f.absent(rPane,'button','Run submit-for-review');
  await open(a,aPane,'draft',3);
  await f.fill(aPane,'summary','A revised fictional description.');
  await f.click(aPane,'Run submit-for-review','Analyst resubmits the returned v1',()=>seen(aPane,'Awaiting independent review · '+recipe.id+' version 1 · revision 4'));
  await open(r,rPane,'awaiting-review',4);
  const approves=rPane.locator('article').filter({has:b(r,'Run approve')});
  await f.fill(approves,'reason','Reviewed the revised sample.');
  await f.click(approves,'Run approve','Reviewer reaches immutable terminal state',()=>seen(rPane,'No transitions from this state.'));
  const audit=JSON.parse(await f.download(r,rPane,'Export full workflow audit JSON','audit.json')).audit;
  const accepted=audit.filter(e=>e.kind==='instance.advance'&&e.outcome==='accepted');
  assert.deepEqual(accepted.map(e=>[e.transitionId,e.actor.id]),[
    ['submit-for-review','qa-author'],['return-for-changes','qa-reviewer'],['submit-for-review','qa-author'],['approve','qa-reviewer']
  ]);
  f.finish();
});

test('browser identity: dedicated administrator re-enables and revokes sessions; other workspace stays signed in',enabled,async t=>{
  const f=await fixture(t);
  const cookie=await f.httpLogin('qa-admin');
  await f.http('identity-admin',{cookie,body:{target:'qa-author',operation:'disable',reason:'assignment-ended',expectedRevision:0}});
  const admin=await f.operator('qa-admin'),outside=await f.operator('qa-author','south');
  const root=admin.locator('#identity-admin-view');
  const row=id=>root.locator('article').filter({has:h(admin,id)});
  const author=row('qa-author');
  await seen(author,'Disabled in this workspace');
  await seen(row('qa-admin'),'Protected administrator seat.');
  await f.absent(root,'heading','qa-other-admin');
  await f.absent(admin,'button','Reporting');
  async function operation(caption,reason,result,witness){
    await f.disclose(author,caption);
    const form=author.getByRole('form',{name:caption+' for qa-author',exact:true});
    await f.select(form,'Reason',reason);
    await f.check(form,/Confirm this action/);
    await f.click(form,caption,result,witness);
    const title=h(author,'qa-author');
    assert.equal(await title.evaluate(e=>e===document.activeElement),true);
  }
  await operation('Enable workspace access','assignment-restored','North membership re-enabled',async()=>{
    await seen(author,'Active');
    await seen(root,'Access enabled · qa-author');
  });
  const work=await f.operator('qa-author');
  await f.absent(work,'button','Identity administration');
  await operation('Revoke workspace sessions','session-reset','North session generation revoked while membership remains enabled',async()=>{
    await seen(author,'Active');
    await seen(root,'Sessions revoked · qa-author');
  });
  // Existing workbench tab is stale. A genuine product request rechecks the session.
  await f.nav(work,'Reporting',()=>h(work,'Sign in to a local workspace').waitFor());
  assert.equal(await work.locator('#workbench').isHidden(),true);
  await f.nav(outside,'Reporting',()=>h(outside,'Operational reporting').waitFor());
  await seen(outside.locator('#local-account'),'qa-author · analyst');
  await f.signIn(work,'qa-author');
  await f.nav(work,'Reporting',()=>h(work,'Operational reporting').waitFor());
  f.finish();
});

test('browser groups: administrator revokes one approved app grant, another expires while operator checks access',enabled,async t=>{
  const f=await fixture(t,{groups:true,oldClock:true});
  const adminCookie=await f.httpLogin('qa-admin'),reviewCookie=await f.httpLogin('qa-reviewer');
  const group='sample-browser-ops';
  let revision=0;
  async function seed(operation,body={},actor=adminCookie){
    const {data}=await f.http('group-governance',{cookie:actor,body:{operation,group,...body,expectedRevision:revision}});
    revision=data.revision;
  }
  const app=target=>({kind:'app',target});
  await seed('create-group');
  await seed('propose-member',{target:'qa-case'});
  for(const id of ['sample-revoked','sample-expiring'])await seed('propose-app',{target:id});
  for(const id of ['sample-revoked','sample-expiring'])await seed('approve',app(id),reviewCookie);
  // Keep membership alive beyond the app expiration; the app grant is the only time-driven change.
  f.clock(-30*24*60*60_000+240_000);
  await seed('approve',{kind:'member',target:'qa-case'},reviewCookie);
  f.clock(0);
  const admin=await f.operator('qa-admin'),review=await f.operator('qa-reviewer'),operator=await f.operator('qa-case');
  const board=admin.locator('#group-governance-view'),reviewBoard=review.locator('#group-governance-view'),scoped=operator.locator('#scoped-applications-view');
  const revoked='Fictional revoked tool',expiring='Fictional expiring tool',empty='No app summaries are currently available to your account.';
  const action='Revoke app grant for sample-revoked';
  await f.nav(operator,'Scoped applications',()=>h(scoped,expiring).waitFor());
  await h(scoped,revoked).waitFor();
  await f.absent(operator,'button','Group governance');
  await f.nav(review,'Group governance',()=>h(reviewBoard,'Application: sample-revoked').waitFor());
  assert.equal(await reviewBoard.locator('summary').filter({hasText:action}).count(),0);
  await f.nav(admin,'Group governance',()=>h(board,'Application: sample-revoked').waitFor());
  await f.disclose(board,action);
  const form=board.getByRole('form',{name:action,exact:true});
  await f.check(form,/Confirm revoke app grant/);
  await f.click(form,'Revoke','Revocation written to board with focus returned to this grant',async()=>{
    await seen(board,'revoked');
    assert.equal(await h(board,'Application: sample-revoked').evaluate(node=>node===document.activeElement),true);
  });
  await f.click(scoped,'Check current app access','Only the still-valid independently approved summary remains',async()=>{
    await h(scoped,expiring).waitFor();
    await f.absent(scoped,'heading',revoked);
  });
  f.clock(120_000);
  await f.click(scoped,'Check current app access','The remaining time-limited grant no longer shows any summary',()=>seen(scoped,empty));
  await f.absent(scoped,'heading',expiring);
  await admin.reload();
  const e=board.locator('.module-record').filter({has:h(admin,'Application: sample-expiring')}).last();
  await f.nav(admin,'Group governance',()=>seen(e,'expired'));
  await seen(e,'expired');
  const m=board.locator('.module-record').filter({has:h(admin,'Member: qa-case')}).last();
  await seen(m,'approved');
  assert.equal(await e.locator('summary').filter({hasText:'Revoke app grant for sample-expiring'}).count(),0);
  await f.disclose(board,'Archive group');
  const archive=board.getByRole('form',{name:'Archive '+group,exact:true});
  await f.check(archive,/Confirm archive/);
  await f.click(archive,'Archive group','Group history remains visibly archived after expiry/revocation',()=>seen(board,'This archived group grants no access.'));
  f.finish();
});

test('browser reporting: isolated reviewer compares both date/outcome-filtered downloads and resets unapplied inputs',enabled,async t=>{
  const f=await fixture(t),author=await f.httpLogin('qa-author');
  const note='Private fictional report payload must not appear.';
  let rows;
  for(const kind of ['correction','portability','access']){
    rows=(await f.http('rights/cases',{cookie:author,body:{kind,owner:'analyst',days:30,note}})).data.cases;
  }
  const ids=rows.map(x=>x.id);
  for(const id of ids.slice(0,2))await f.http('rights/cases/'+id+'/begin',{cookie:author,status:409,body:{expectedRevision:1,note}});
  const day=rows[0].receivedAt.slice(0,10);
  const page=await f.operator('qa-reviewer'),pane=page.locator('#report-view');
  await f.nav(page,'Reporting',()=>h(pane,'Operational reporting').waitFor());
  await f.select(pane,'Report dataset','activity');
  assert.equal(await field(pane,'Report stage').isVisible(),false);
  await f.select(pane,'Report workflow','rights');
  await f.select(pane,'Report outcome','refused');
  await f.select(pane,'Group report by','outcome');
  await f.fill(pane,'Start date (UTC)',day);
  await f.fill(pane,'End date (UTC)',day);
  const expect={dataset:'activity',workflow:'rights',stage:'all',outcome:'refused',group:'outcome',from:day,to:day};
  await f.click(pane,'Apply report filters','Two and only two refused rights events match for the chosen date',async()=>{
    const row=pane.getByRole('row').filter({has:page.getByRole('rowheader',{name:'Refused',exact:true})});
    assert.equal(await row.getByRole('cell').first().innerText(),'2');
    assert.equal(await row.locator('meter').evaluate(e=>e.value),2);
    await seen(page,'Report updated. 2 matched.');
  });
  // Draft inputs are not the currently displayed/reportable result.
  await f.select(pane,'Report outcome','recorded');
  const json=await f.download(page,pane,'Download JSON','mvw-trust-report.json');
  const csv=await f.download(page,pane,'Download CSV','mvw-trust-report.csv');
  const data=JSON.parse(json);
  assert.deepEqual(data.filters,expect);
  assert.deepEqual(data.rows,[{key:'refused',label:'Refused',count:2}]);
  assert.deepEqual(data.counts,{total:2,workflowCount:1,undated:0});
  assert.ok(csv.includes(['activity','rights','all','refused',day,day,'outcome','Refused','2'].map(v=>'"'+v+'"').join(',')+'\r\n'));
  for(const value of [note,...ids])assert.equal((csv+json).includes(value),false);
  await f.click(pane,'Reset report filters','Defaults clear nonapplied edits and date filters',async()=>{
    await h(pane,'Report results').waitFor();
    await seen(pane,'Matching workflow records');
    assert.equal(await field(pane,'Report workflow').inputValue(),'all');
    assert.equal(await field(pane,'Start date (UTC)').inputValue(),'');
    assert.equal(await field(pane,'End date (UTC)').inputValue(),'');
  });
  assert.equal(await b(pane,'Reset report filters').evaluate(e=>document.activeElement===e),true);
  f.finish();
});

test('browser configured PIA/DPIA: stale draft recovery, hidden answers discarded, independent return and corrections',enabled,async t=>{
  const f=await fixture(t),author=await f.httpLogin('qa-author'),reviewer=await f.httpLogin('qa-reviewer');
  let release=(await f.http('assessment-config/create',{cookie:author,body:{expectedRevision:0}})).data;
  const config=structuredClone(release.releases[0].configuration);
  const switchQuestion={id:'outside',label:'Send fictional data externally?',kind:'choice',required:true,options:['Yes','No']};
  const detail=(id,label,kind)=>({id,label,kind,required:true,when:{question:'outside',equals:'Yes'}});
  config.forms.pia={label:'Fictional PIA path',questions:[switchQuestion,detail('recipients','Synthetic recipients list','text')]};
  config.forms.dpia={label:'Fictional DPIA path',questions:[switchQuestion,detail('regions','Fictional region count','integer')]};
  for(const [action,cookie,fields] of [
    ['edit',author,{configuration:config}],['submit',author,{}],['publish',reviewer,{note:'Approved both fictional branches.'}]
  ])release=(await f.http('assessment-config/'+action,{cookie,body:{expectedRevision:release.revision,...fields}})).data;
  const project='Fictional dynamic questionnaire program';
  const state=(await f.http('projects',{cookie:author,body:{name:project}})).data;
  const {id}=state.projects.find(p=>p.name===project);
  for(const [name,sensitive] of [['Ordinary sample vendor',false],['Sensitive sample vendor',true]])await f.http('vendors',{cookie:author,body:{projectId:id,name,usesAI:false,handlesSensitiveData:sensitive}});
  const page=await f.operator('qa-author'),stale=await f.operator('qa-author'),review=await f.operator('qa-reviewer');
  const card=(p,form)=>p.locator('.assessment').filter({hasText:form+' ·'});
  const pia=card(page,'Fictional PIA path'),dpia=card(page,'Fictional DPIA path'),old=card(stale,'Fictional PIA path'),rd=card(review,'Fictional DPIA path');
  const choice='Send fictional data externally?',list='Synthetic recipients list',count='Fictional region count';
  const note='Narrow the fictional safeguards.';
  async function open(p,form){
    await f.click(p,project,'Opened the synthetic project with PIA and DPIA routes',()=>card(p,form).waitFor());
  }
  await open(page,'Fictional PIA path');
  await open(stale,'Fictional PIA path');
  await seen(pia,'Configuration v1 · Rule standard-review');
  await seen(dpia,'Configuration v1 · Rule sensitive-review');
  await f.fill(pia,'Summary','Updated main-session PIA summary.');
  await f.fill(pia,'Safeguards','Fictional PIA controls.');
  await f.select(pia,choice,'Yes',()=>field(pia,list).waitFor());
  await f.fill(pia,list,'Temporary fictional recipient.');
  await f.click(pia,'Save draft','PIA inputs and conditional answer persist',async()=>{
    await seen(page,'Draft saved.');
    assert.equal(await field(pia,list).inputValue(),'Temporary fictional recipient.');
  });
  await f.fill(old,'Summary','Stale text must never overwrite.');
  await f.click(old,'Save draft','Second tab cannot overwrite saved work',()=>b(stale,'Reload latest').waitFor());
  await f.click(stale,'Reload latest','Refresh restores committed answers, not stale values',async()=>{
    await seen(stale,'Latest records loaded.');
    assert.equal(await field(old,'Summary').inputValue(),'Updated main-session PIA summary.');
  });
  await f.select(pia,choice,'No',()=>field(pia,list).waitFor({state:'hidden'}));
  assert.equal(await field(pia,list).inputValue(),'');
  await f.click(pia,'Submit for review','Closed PIA branch is omitted at submission',()=>seen(pia,'in review'));
  assert.equal(await pia.getByText(/Temporary fictional recipient/).count(),0);
  await f.fill(dpia,'Summary','DPIA fictional project summary.');
  await f.fill(dpia,'Safeguards','Initial fictional DPIA controls.');
  await f.select(dpia,choice,'Yes',()=>field(dpia,count).waitFor());
  await f.fill(dpia,count,'2.5');
  await f.click(dpia,'Submit for review','Integer field blocks decimal answer without submission',async()=>{
    assert.equal(await field(dpia,count).evaluate(x=>x.validity.patternMismatch),true);
    await seen(dpia,'draft');
  });
  await f.fill(dpia,count,'2');
  await f.click(dpia,'Submit for review','DPIA submission keeps exact numeric answer',()=>seen(dpia,count+': 2'));
  await review.reload();
  await open(review,'Fictional DPIA path');
  await f.absent(rd,'button','Save draft');
  await f.fill(rd,'Decision reason',note);
  await f.click(rd,'Return for changes','Reviewer returns the DPIA only',()=>seen(rd,'Reviewer decision: '+note));
  await seen(card(review,'Fictional PIA path'),'in review');
  await page.reload();
  await open(page,'Fictional DPIA path');
  await seen(dpia,'Returned by reviewer: '+note);
  await f.fill(dpia,'Safeguards','Revised and scoped fictional DPIA controls.');
  await f.select(dpia,choice,'No',()=>field(dpia,count).waitFor({state:'hidden'}));
  assert.equal(await field(dpia,count).inputValue(),'');
  await f.click(dpia,'Submit for review','Returned DPIA resubmits without old branch value',()=>seen(dpia,'in review'));
  await review.reload();
  await open(review,'Fictional DPIA path');
  await seen(rd,'Safeguards: Revised and scoped fictional DPIA controls.');
  assert.equal(await rd.getByText(new RegExp('^'+count+':')).count(),0);
  await f.click(rd,'Approve assessment','Different account approves the corrected DPIA',()=>seen(rd,'approved'));
  const latest=(await f.http('state',{cookie:author})).data.assessments.filter(a=>a.projectId===id);
  assert.equal(latest.find(a=>a.routing.form==='pia').answers.recipients,undefined);
  assert.equal(latest.find(a=>a.routing.form==='dpia').answers.regions,undefined);
  f.finish();
});
