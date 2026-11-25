'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,relative,isAbsolute}=require('node:path');

const b=(scope,label)=>scope.getByRole('button',{name:label,exact:true});
const h=(scope,label)=>scope.getByRole('heading',{name:label,exact:true});
const see=(scope,text)=>scope.getByText(text,{exact:true}).first().waitFor();
const workspaceNames={harbor:'Harbor',orchard:'Orchard'};
const opposite=workspace=>workspace==='harbor'?'orchard':'harbor';
const allOperators='home assessments assessment-config my-work queue rights incidents vendor-monitoring data-map processing-register dictionary preferences retention governance-docs employee-attestations training risk-controls audit-management maturity-planning workflow-studio trust-center report modules operator-jobs';
const grants={
  analyst:(allOperators+' scoped-applications').split(' '),
  reviewer:(allOperators+' group-governance document-access directory-lifecycle').split(' '),
  'case-operator':'home my-work rights governance-docs scoped-applications'.split(' '),
  'identity-admin':'identity-admin directory-lifecycle document-access group-governance'.split(' '),
  publisher:['workflow-studio'],'ethics-investigator':['ethics'],'ethics-reviewer':['ethics']
};
// Independently maintained acceptance expectations, not derived from the permission implementation.
const views={
  home:['workspace-home','My next actions',null],
  assessments:[null,'Projects',null],
  'assessment-config':['assessment-config','Assessment configuration','Active configuration: built-in privacy and AI questionnaires'],
  'my-work':['my-work','Assigned work',null],
  'operator-jobs':['operator/v1/jobs','Jobs','No operator jobs yet.'],
  queue:['work-queue','Actionable work',null],
  rights:['rights/cases','Privacy rights cases',null],
  incidents:['incidents/cases','Privacy incidents',null],
  'vendor-monitoring':['vendor-monitoring','Monitoring cases','No vendor monitoring cases.'],
  'data-map':['data-map','Inventory','No discovery rehearsals have been queued.'],
  'processing-register':['processing-register','Processing register','No processing entries yet.'],
  dictionary:['dictionary','Governed data dictionary','No governed terms yet.'],
  preferences:['privacy-notices','Notice revision history','No privacy notices yet.'],
  retention:['retention','Versioned retention schedules','No fictional schedules.'],
  'governance-docs':['governance-documents','Document revisions','No documents are visible to this demo identity.'],
  training:['training','Training courses','No training courses yet.'],
  'employee-attestations':['employee-attestations','Assignment history','No policy assignments yet.'],
  'risk-controls':['risk-controls','Risk register','No fictional risks.'],
  'audit-management':['audit-management','Audit plans','No audit plans yet.'],
  'workflow-studio':['workflows/studio','Published definitions','No published workflows yet.'],
  'trust-center':['trust-center','Privacy practices','No active publication.'],
  'maturity-planning':['maturity-planning','Program plans','No maturity plans yet.'],
  ethics:['ethics/cases','Synthetic ethics case management',null],
  'identity-admin':['identity-admin','Workspace account roster','No access changes recorded.'],
  'directory-lifecycle':['directory-lifecycle','Versioned suspension plans','No suspension plans have been prepared.'],
  'document-access':['document-access','Workspace document access requests','No requests have been recorded.'],
  'group-governance':['group-governance','Workspace groups','No synthetic groups have been set up.'],
  'scoped-applications':['scoped-applications','Applications available to your account','No app summaries are currently available to your account.'],
  report:['reporting','Report results',null],
  modules:['modules','Program modules','No synthetic records in this module yet.']
};
const paneId=view=>view==='assessments'?'assessment-view':view==='modules'?'module-view':view==='incidents'?'incident-view':view+'-view';
const project=workspace=>'Synthetic navigation project '+workspaceNames[workspace];
const mapNode=workspace=>'Synthetic navigation dataset '+workspaceNames[workspace];
const privateCase=(workspace,key)=>'Synthetic navigation '+key+' case '+workspaceNames[workspace];
const incident=workspace=>'Synthetic navigation incident '+workspaceNames[workspace];
const taskName={analyst:'Triage severity',reviewer:'Review identity independently','case-operator':'Begin mock fulfillment'};

async function launchRelease(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-nav-release-'));
  const launcher=resolve(__dirname,'../start-release.js');
  const child=spawn(process.execPath,[launcher,'--port','0'],{
    cwd:room,env:{...process.env,TMPDIR:room,TMP:room,TEMP:room},stdio:['ignore','pipe','pipe']
  });
  const exit=once(child,'exit');
  // This always runs against a fresh private release fixture, not an existing user run.
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}
    await rm(room,{recursive:true,force:true,maxRetries:2});
  });
  const line=await new Promise((done,fail)=>{
    let buffer='';
    const deadline=setTimeout(()=>fail(Error('Local release fixture did not announce readiness.')),20_000);
    child.once('error',error=>{clearTimeout(deadline);fail(error);});
    exit.then(()=>{clearTimeout(deadline);fail(Error('Local release fixture exited before starting.'));},fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.includes('\n')){
        clearTimeout(deadline);
        done(buffer.split('\n')[0]);
      }
    });
    child.stderr.resume();
  });
  const local=JSON.parse(line);
  assert.equal(local.status,'ready');
  assert.match(local.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const rel=relative(room,local.accessFile);
  assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  const seatList=JSON.parse(await readFile(local.accessFile,'utf8'));
  assert.equal(seatList.mode,'local-synthetic-only');
  const seats=seatList.staff.flatMap(({id,code,memberships})=>Object.entries(memberships).map(([workspace,role])=>({id,code,workspace,role})));
  assert.deepEqual(new Set(seats.map(x=>x.role)),new Set(Object.keys(grants)));
  async function request(route,workspace,cookie,body){
    const res=await fetch(local.url+'/api/'+route+(workspace?'?workspace='+workspace:''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:local.url,'Content-Type':'application/json'})},
      signal:AbortSignal.timeout(6000)
    });
    assert.equal(res.status,200,route+' on '+workspace+' status '+res.status);
    return {data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function auth(role,workspace){
    const seat=seats.find(x=>x.role===role&&x.workspace===workspace);
    return (await request('session/login',null,null,{account:seat.id,workspace,code:seat.code})).cookie;
  }
  for(const workspace of Object.keys(workspaceNames)){
    const a=await auth('analyst',workspace),r=await auth('reviewer',workspace);
    await request('projects',workspace,a,{name:project(workspace)});
    await request('data-map/nodes',workspace,a,{expectedRevision:0,type:'dataset',name:mapNode(workspace),
      owner:'Fictional inventory steward',detail:'No samples in this release fixture.'});
    await request('incidents/cases',workspace,a,{title:incident(workspace),scope:'Fictional triage scenario.'});
    const grant=await request('rights/cases',workspace,a,{kind:'access',owner:'case-operator',days:30,note:privateCase(workspace,'delegated')});
    const first=grant.data.cases.find(x=>x.kind==='access');
    await request('rights/cases/'+first.id+'/verify',workspace,r,{expectedRevision:1,note:'Fictional review of identity.'});
    await request('rights/cases/'+first.id+'/delegation',workspace,a,
      {expectedRevision:2,account:'sample-case-operator',operation:'delegate',reason:'case-assignment'});
    await request('rights/cases',workspace,a,{kind:'deletion',owner:'analyst',days:30,note:privateCase(workspace,'restricted')});
    const ethics=await auth('ethics-investigator',workspace);
    await request('ethics/cases',workspace,ethics,{category:'gift',urgency:'priority'});
  }
  return {url:local.url,seats};
}

test('Chromium release keyboard audit exercises every available top-level tab for each generated staff membership',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Chromium and Playwright',timeout:120_000
},async t=>{
  const f=await launchRelease(t);
  const {chromium}=require('playwright'),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const pageErrors=[],external=[],rows=[];
  let denied=0,hidden=0,assessmentsOmitted=0,auditExportsUnavailable=0,crossWorkspaces=0;
  async function newContext(viewport={width:1440,height:1000}){
    const context=await browser.newContext({viewport,reducedMotion:'reduce'});
    await context.route('**/*',route=>{
      if(new URL(route.request().url()).origin===f.url)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    const page=await context.newPage();
    page.setDefaultTimeout(6500);page.on('pageerror',error=>pageErrors.push(error.message));
    return {context,page};
  }
  async function browserGet(page,path,workspace){
    return page.evaluate(async({path,workspace})=>{
      const reply=await fetch('/api/'+path+(workspace?'?workspace='+workspace:''));
      return {status:reply.status,data:await reply.json()};
    },{path,workspace});
  }
  async function signin(page,seat){
    await page.getByLabel('Test account',{exact:true}).fill(seat.id);
    await page.getByLabel('Workspace ID',{exact:true}).fill(seat.workspace);
    await page.getByLabel('Local access code',{exact:true}).fill(seat.code);
    await b(page,'Sign in').press('Enter');
    await see(page.locator('#local-account'),seat.id+' · '+seat.role);
  }
  async function witness(page,scope,key,{role,workspace}){
    const [,headline,text]=views[key];
    await h(scope,headline).first().waitFor();
    if(text){
      await see(scope,text);
      return text;
    }
    if(key==='home'){
      await see(scope,'Local workspace · current verified role');
      const open=scope.locator('section').filter({has:h(page,'My next actions')});
      assert.equal(await open.locator('dt').filter({hasText:/^Open$/}).locator('..').locator('dd').innerText(),'1');
      const limited=role==='case-operator';
      assert.equal(await h(scope,'Workspace triage').count(),limited?0:1);
      return limited?'One assigned task; no workspace aggregate':'One assigned task; workspace aggregate';
    }
    if(key==='assessments'){
      await h(scope,project(workspace)).waitFor();
      assert.equal(await h(scope,project(opposite(workspace))).count(),0);
      return 'Current workspace project only';
    }
    if(key==='rights'){
      await see(scope,privateCase(workspace,'delegated'));
      assert.equal(await scope.getByText(privateCase(workspace,'restricted'),{exact:true}).count(),role==='case-operator'?0:1);
      assert.equal(await scope.getByText(privateCase(opposite(workspace),'delegated'),{exact:true}).count(),0);
      return 'Own workspace rights; delegated-only for case operator';
    }
    if(key==='incidents'){
      await h(scope,incident(workspace)).waitFor();
      assert.equal(await h(scope,incident(opposite(workspace))).count(),0);
      return 'Workspace-specific incident';
    }
    if(key==='my-work'||key==='queue'){
      await h(scope,taskName[role]).first().waitFor();
      if(role==='case-operator')assert.equal(await scope.locator('article').count(),1);
      return 'Expected role-specific next action';
    }
    if(key==='ethics'){
      if(role==='ethics-investigator'){
        await scope.getByRole('heading',{name:/^ETH-0001 · /}).waitFor();
        assert.equal(await scope.locator('article').count(),1);
        return 'Fictional case visible only in investigator queue';
      }
      await see(scope,'No case has been submitted for independent review.');
      assert.equal(await scope.locator('article').count(),0);
      return 'Not-yet-submitted case is absent from independent review';
    }
    if(key==='report'){
      const metric=scope.getByText('Matching workflow records',{exact:true}).locator('..').locator('strong');
      assert.equal(await metric.innerText(),'4');
      for(const [name,total] of [['Privacy rights','2'],['Incidents','1'],['Project handoffs','1']]){
        const row=scope.getByRole('row').filter({has:page.getByRole('rowheader',{name,exact:true})});
        assert.equal(await row.getByRole('cell').first().innerText(),total);
      }
      return 'Report counts two rights cases, one incident, and one handoff';
    }
    assert.fail('Unspecified observed outcome for '+key);
  }
  for(const seat of f.seats){
    const {context,page}=await newContext();
    try{
      await page.goto(f.url);
      await signin(page,seat);
      const session=(await browserGet(page,'session')).data;
      assert.equal(session.actor,seat.role);
      assert.equal(session.workspace,seat.workspace);
      assert.equal(session.account,seat.id);
      const expected=grants[seat.role];
      assert.deepEqual(new Set(session.capabilities.views),new Set(expected));
      const nav=page.locator('#work-tabs');
      const allTabs=await nav.locator('button').evaluateAll(buttons=>buttons.map(x=>x.id.slice(5)));
      assert.deepEqual(new Set(allTabs),new Set(Object.keys(views)));
      const visible=await nav.locator('button:visible').evaluateAll(buttons=>buttons.map(x=>x.id.slice(5)));
      assert.deepEqual(new Set(visible),new Set(expected),'Release role '+seat.role+' in '+seat.workspace);
      assert.equal(await page.getByLabel('Demo identity',{exact:true}).isVisible(),false);
      const available=await browserGet(page,'state',seat.workspace);
      assert.equal(available.status,200);
      assert.equal((await browserGet(page,'state',opposite(seat.workspace))).status,403);
      crossWorkspaces++;
      if(!expected.includes('assessments')){
        assert.deepEqual(available.data.projects,[]);
        assert.deepEqual(available.data.assessments,[]);
        assert.deepEqual(available.data.vendors,[]);
        assessmentsOmitted++;
      }
      const deniedViews=Object.keys(views).filter(key=>!expected.includes(key));
      for(const key of deniedViews){
        assert.equal(await nav.locator('#show-'+key).isVisible(),false);
        assert.equal(await page.locator('#'+paneId(key)).isVisible(),false);
        hidden++;
      }
      await Promise.all(deniedViews.filter(key=>!!views[key][0]).map(async key=>{
        const [path]=views[key];
        const result=await browserGet(page,path,seat.workspace);
        assert.equal(result.status,403,seat.role+' cannot read '+path);
        denied++;
      }));
      if(seat.role!=='reviewer'){
        assert.equal((await browserGet(page,'audit/export',seat.workspace)).status,403);
        auditExportsUnavailable++;
      }
      for(const key of visible){
        const button=nav.locator('#show-'+key),scope=page.locator('#'+paneId(key));
        const label=(await button.innerText()).trim();
        await button.press('Enter');
        const outcome=await witness(page,scope,key,seat);
        await scope.waitFor();
        assert.equal(await button.getAttribute('aria-current'),'true');
        assert.equal(await nav.locator('button[aria-current="true"]').count(),1);
        const headline=key==='home'?'Trust operations':key==='assessments'?'Assessment workspace':label;
        assert.equal(await page.locator('#view-title').innerText(),headline);
        for(const other of Object.keys(views).filter(x=>x!==key))
          assert.equal(await page.locator('#'+paneId(other)).isVisible(),false);
        if(key==='data-map'){
          await h(scope,mapNode(seat.workspace)).waitFor();
          assert.equal(await h(scope,mapNode(opposite(seat.workspace))).count(),0);
        }
        const observed=await scope.locator('button:visible,a[href]:visible,input:visible,select:visible,textarea:visible,summary:visible')
          .evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName.toLowerCase(),disabled:!!node.disabled})));
        rows.push({workspace:seat.workspace,role:seat.role,view:key,
          nav:'keyboard-activated-and-witnessed',outcome,observedNotActivated:observed.length,observedDisabled:observed.filter(x=>x.disabled).length});
      }
    }finally{await context.close();}
  }
  assert.equal(rows.length,f.seats.reduce((sum,x)=>sum+grants[x.role].length,0));
  // A separate compact session exercises the actual role-changing workspace control and sign-out.
  const {context,page}=await newContext({width:390,height:844});
  try{
    await page.goto(f.url);
    const skip=page.getByRole('link',{name:'Skip to sign-in',exact:true});
    await skip.waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await skip.evaluate(x=>x===document.activeElement),true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#local-signin').evaluate(x=>x===document.activeElement),true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByLabel('Test account',{exact:true}).evaluate(x=>x===document.activeElement),true);
    const switching=f.seats.find(x=>x.id==='sample-intake'&&x.workspace==='harbor');
    await signin(page,switching);
    await b(page,'Browse workspace').press('Space');
    assert.equal(await b(page,'Browse workspace').getAttribute('aria-expanded'),'true');
    await b(page,'Assessments').press('Enter');
    await h(page,project('harbor')).waitFor();
    assert.equal(await b(page,'Browse workspace').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('#view-title').evaluate(node=>node===document.activeElement),true);
    await page.getByLabel('Workspace',{exact:true}).selectOption('orchard');
    await b(page,'Switch workspace').press('Enter');
    await see(page.locator('#local-account'),'sample-intake · reviewer');
    await b(page,'Browse workspace').press('Space');
    await b(page,'Assessments').press('Enter');
    await h(page,project('orchard')).waitFor();
    assert.equal(await h(page,project('harbor')).count(),0);
    assert.equal((await browserGet(page,'state','harbor')).status,403);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await b(page,'Sign out').press('Enter');
    await h(page,'Sign in to a local workspace').waitFor();
    assert.equal(await page.locator('#workbench').isHidden(),true);
    assert.equal((await browserGet(page,'state','orchard')).status,401);
  }finally{await context.close();}
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(external,[]);
  t.diagnostic(JSON.stringify({
    workspaceMemberships:f.seats.length,provisionedRoles:Object.keys(grants).length,
    topLevelActivatedAndWitnessed:rows.length,observedControlsNotActivated:rows.reduce((sum,x)=>sum+x.observedNotActivated,0),
    observedDisabled:rows.reduce((sum,x)=>sum+x.observedDisabled,0),hiddenTabsVerified:hidden,
    deniedViewReads:denied,assessmentsStateOmissionChecks:assessmentsOmitted,auditExportDenials:auditExportsUnavailable,
    crossWorkspaceDenials:crossWorkspaces,compactJourney:'skip, disclosure, focus, switch-role and sign-out checked separately',rows
  }));
});
