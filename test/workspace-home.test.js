'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {codeHash}=require('../workspace-access');
const {createServer}=require('../server');
const {dashboard}=require('../workspace-home');
const {capabilities}=require('../access-policy');

const chrome={skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:45_000};
const b=(scope,name)=>scope.getByRole('button',{name,exact:true});
const h=(scope,name)=>scope.getByRole('heading',{name,exact:true});
const see=(scope,text)=>scope.getByText(text,{exact:true}).waitFor();
const needle='Fictional private narrative should never appear on Home';
const queueKeys=['dueToday','overdue','total','undated','upcoming'].sort();

async function fixture(t,{demo=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-workspace-home-'));
  const roles=['analyst','reviewer','case-operator','identity-admin','publisher','ethics-reviewer'];
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const spaces=[{id:'north',label:'Fictional North'},{id:'south',label:'Fictional South'}];
  const accounts=roles.map(role=>({id:'synthetic-'+role,codeHash:codeHash(codes[role]),memberships:{north:role,south:role}}));
  const options=demo?{dataFile:join(root,'local.json')}:{isolated:{root,workspaces:spaces,accounts,enableIdentityAdmin:true}};
  const server=createServer(options).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
  const url='http://127.0.0.1:'+server.address().port;
  async function api(path,{workspace='north',cookie,body,role,status=200}={}){
    const r=await fetch(url+'/api/'+path+(!demo&&workspace?(path.includes('?')?'&':'?')+'workspace='+workspace:''),{
      method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(role?{'X-Demo-Actor':role}:{}),
        ...(body===undefined?{}:{'Content-Type':'application/json',Origin:url})},body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await r.json();
    assert.equal(r.status,status,JSON.stringify(data));
    assert.equal(r.headers.get('cache-control'),'no-store');
    return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(role,workspace='north')=>(await api('session/login',{workspace:null,body:{account:'synthetic-'+role,workspace,code:codes[role]}})).cookie;
  async function standardSeed(){
    const a=demo?null:await login('analyst'),r=demo?null:await login('reviewer');
    const create={cookie:a,role:'analyst'};
    const open=async(kind,owner)=>{
      const {data}=await api('rights/cases',{...create,body:{kind,owner,days:7,note:needle}});
      return data.cases.find(x=>x.kind===kind);
    };
    const owned=await open('access','case-operator'),other=await open('correction','analyst');
    await api('rights/cases/'+owned.id+'/verify',{cookie:r,role:'reviewer',body:{expectedRevision:1,note:needle}});
    await api('incidents/cases',{...create,body:{title:'Fictional incident Alpha',scope:needle}});
    return {owned,other};
  }
  async function browser(){
    const {chromium}=require('playwright');
    const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
    t.after(()=>browser.close());
    const errors=[],external=[];
    async function page(viewport={width:1440,height:1000}){
      const p=await browser.newPage({viewport,reducedMotion:'reduce'});
      p.on('pageerror',e=>errors.push(e.message));
      p.setDefaultTimeout(7000);
      await p.route('**/*',r=>{
        if(new URL(r.request().url()).origin===url)return r.continue();
        external.push(r.request().url());return r.abort();
      });
      return p;
    }
    async function sign(p,role,workspace='north'){
      await p.goto(url);
      if(demo)return;
      await p.getByLabel('Test account',{exact:true}).fill('synthetic-'+role);
      await p.getByLabel('Workspace ID',{exact:true}).fill(workspace);
      await p.getByLabel('Local access code',{exact:true}).fill(codes[role]);
      await b(p,'Sign in').click();
      await see(p,'synthetic-'+role+' · '+role);
    }
    return {page,sign,end(){assert.deepEqual(errors,[]);assert.deepEqual(external,[]);}};
  }
  return {api,login,standardSeed,browser,url};
}

function meter(scope,label){
  return scope.locator('dt').filter({hasText:new RegExp('^'+label+'$')}).locator('..').locator('dd');
}
const card=(p,heading)=>p.locator('#home-view section').filter({has:h(p,heading)});

test('dashboard time buckets, workflow priority and empty output use the actual queue model',()=>{
  const dates=['2028-01-04','2028-01-05','2028-01-06'];
  const base={actors:[{id:'analyst'},{id:'reviewer'},{id:'case-operator'}],assessments:[],vendors:[]};
  const full={...base,rightsCases:dates.map((dueDate,i)=>({id:'case-'+i,identity:{status:'verified'},owner:'analyst',kind:'access',dueDate,status:'received'})),
    incidentCases:[{id:'consult-1',title:needle,stage:'logged',owner:'analyst'}]};
  const opts={mode:'synthetic-demo',actor:'analyst',views:capabilities('analyst').views};
  const d=dashboard(full,opts,new URLSearchParams(),'2028-01-05');
  assert.deepEqual(d.assigned,{total:4,overdue:1,dueToday:1,upcoming:1,undated:1});
  assert.deepEqual(d.triage.workflows,[{id:'rights',label:'Privacy rights',total:3,overdue:1,dueToday:1},{id:'incidents',label:'Incidents',total:1,overdue:0,dueToday:0}]);
  assert.doesNotMatch(JSON.stringify(d),/case-\d|consult-1|Fictional private narrative/);
  assert.deepEqual(dashboard(base,opts,new URLSearchParams(),'2028-01-05').triage.workflows,[]);
});

test('workspace home HTTP serves only aggregate authorized role/workspace data, with no edit, export, or search path',async t=>{
  const f=await fixture(t),{owned,other}=await f.standardSeed();
  await f.api('workspace-home',{status:401});
  const analyst=await f.login('analyst'),reviewer=await f.login('reviewer'),caseSeat=await f.login('case-operator');
  const a=(await f.api('workspace-home',{cookie:analyst})).data,r=(await f.api('workspace-home',{cookie:reviewer})).data;
  const c=(await f.api('workspace-home',{cookie:caseSeat,role:'analyst'})).data;
  assert.equal(r.assigned.total,1);
  assert.ok(a.assigned.total>=1);
  assert.deepEqual(a.triage,r.triage);
  assert.equal(a.triage.workflows.find(x=>x.id==='rights').total,2);
  assert.equal(a.triage.workflows.find(x=>x.id==='incidents').total,1);
  assert.deepEqual(Object.keys(a).sort(),['asOf','assigned','mode','scope','triage']);
  assert.deepEqual(Object.keys(c).sort(),['asOf','assigned','mode','scope']);
  assert.deepEqual(Object.keys(c.assigned).sort(),queueKeys);
  assert.deepEqual(c.assigned,{total:1,overdue:0,dueToday:0,upcoming:1,undated:0});
  assert.equal(c.scope,'assigned-seat');
  for(const row of [a,r,c])for(const privateValue of [owned.id,other.id,needle,'Fictional incident Alpha']){
    assert.equal(JSON.stringify(row).includes(privateValue),false);
  }
  const otherSeat=await f.login('case-operator','south');
  assert.equal((await f.api('workspace-home',{workspace:'south',cookie:otherSeat})).data.assigned.total,0);
  await f.api('workspace-home',{workspace:'south',cookie:caseSeat,status:403});
  await f.api('workspace-home?owner=analyst',{cookie:caseSeat,status:422});
  await f.api('workspace-home/export',{cookie:reviewer,status:404});
  await f.api('workspace-home',{cookie:reviewer,status:404,body:{}});
  for(const role of ['identity-admin','publisher','ethics-reviewer']){
    await f.api('workspace-home',{cookie:await f.login(role),status:403});
  }
});

test('Chromium home demo: real counts, desktop layout, working queue/report destinations and failed-refresh recovery',chrome,async t=>{
  const f=await fixture(t,{demo:true});
  await f.standardSeed();
  const browser=await f.browser();
  const p=await browser.page();
  const home=p.locator('#home-view');
  await p.context().addInitScript({content:require('axe-core').source});
  await browser.sign(p);
  await h(p,'Trust operations').waitFor();
  await h(home,'My next actions').waitFor();
  const personal=card(p,'My next actions'),triage=card(p,'Workspace triage');
  const expected=(await f.api('workspace-home',{role:'analyst'})).data;
  assert.equal(await meter(personal,'Open').innerText(),String(expected.assigned.total));
  assert.equal(await meter(triage,'Open').innerText(),String(expected.triage.total));
  const breakdown=card(p,'Where work is open');
  const metrics=breakdown.locator('li').filter({has:h(p,'Privacy rights')});
  await see(metrics,'2 open · 0 overdue · 0 due today');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),1440);
  const violations=await p.evaluate(async()=>(await axe.run(document.querySelector('#home-view'),{
    runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}
  })).violations.map(v=>({id:v.id,affected:v.nodes.map(n=>n.target)})));
  assert.deepEqual(violations,[]);
  await b(p,'Solid surfaces').click();
  assert.equal(await personal.evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await b(home,'Triage Privacy rights').click();
  await h(p,'Work queue').first().waitFor();
  const queue=p.locator('#queue-view');
  assert.equal(await queue.getByLabel('Workflow filter').inputValue(),'rights');
  assert.equal(await queue.getByLabel('Queue owner').inputValue(),'all');
  assert.equal(await p.locator('#view-title').evaluate(e=>e===document.activeElement),true);
  await b(p,'Home').click();
  await b(home,'Open Operational Reporting').click();
  await h(p,'Operational reporting').waitFor();
  await b(p,'Home').click();
  await b(home,'Open Incident Triage').click();
  await h(p,'Incidents').waitFor();
  await b(p,'Home').click();
  await p.getByLabel('Demo identity',{exact:true}).selectOption('reviewer');
  await b(home,'Open demo role queue').click();
  assert.equal(await queue.getByLabel('Queue owner').inputValue(),'reviewer');
  await b(p,'Home').click();
  await b(home,'Refresh home summary').waitFor();
  await p.route('**/api/workspace-home',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Do not display raw upstream error"}'}),{times:1});
  await b(home,'Refresh home summary').click();
  await h(home,'Summary unavailable').waitFor();
  assert.equal(await home.locator('dl').count(),0);
  assert.equal(await home.getByText('Do not display raw upstream error',{exact:true}).count(),0);
  await b(home,'Retry home summary').click();
  await h(home,'My next actions').waitFor();
  assert.equal(await b(home,'Refresh home summary').evaluate(e=>e===document.activeElement),true);
  if(process.env.HOME_SCREENSHOT_DIR){
    await b(p,'Solid surfaces').click();
    await p.evaluate(()=>window.scrollTo(0,0));
    await p.screenshot({path:join(process.env.HOME_SCREENSHOT_DIR,'mvw-home-desktop.png'),fullPage:true});
  }
  browser.end();
});

test('Chromium home isolated: mobile assigned-only case view, workspace switch, specialist gating and secure destinations',chrome,async t=>{
  const f=await fixture(t);
  await f.standardSeed();
  const browser=await f.browser();
  const casePage=await browser.page({width:390,height:844});
  await browser.sign(casePage,'case-operator');
  const home=casePage.locator('#home-view');
  const personal=card(casePage,'My next actions');
  await h(personal,'My next actions').waitFor();
  assert.equal(await meter(personal,'Open').innerText(),'1');
  assert.equal(await meter(personal,'Upcoming').innerText(),'1');
  for(const name of ['Workspace triage','Where work is open'])assert.equal(await h(home,name).count(),0);
  for(const name of ['Open shared queue','Open Operational Reporting','Open Incident Triage'])assert.equal(await b(home,name).count(),0);
  assert.equal(await casePage.evaluate(()=>document.documentElement.scrollWidth),390);
  if(process.env.HOME_SCREENSHOT_DIR)await casePage.screenshot({path:join(process.env.HOME_SCREENSHOT_DIR,'mvw-home-case-mobile.png'),fullPage:true});
  await b(home,'Open My Work').focus();
  await casePage.keyboard.press('Enter');
  await h(casePage,'Assigned work').waitFor();
  assert.equal(await casePage.locator('#view-title').evaluate(e=>e===document.activeElement),true);
  await casePage.getByRole('link',{name:/^Open assigned record: access request/}).waitFor();
  assert.equal(await casePage.getByRole('link',{name:/correction request/}).count(),0);
  await b(casePage,'Browse workspace').click();
  await b(casePage,'Home').click();
  await b(home,'Open Policies and Documents').click();
  await h(casePage,'Policies and evidence documents').waitFor();
  await casePage.getByLabel('Workspace',{exact:true}).selectOption('south');
  await b(casePage,'Switch workspace').click();
  await see(personal,'Nothing is currently assigned. New work will appear here after its workflow moves to your role.');
  assert.equal(await meter(personal,'Open').innerText(),'0');
  assert.equal(await h(home,'Workspace triage').count(),0);
  const reviewer=await browser.page();
  await browser.sign(reviewer,'reviewer');
  const workspace=card(reviewer,'Workspace triage');
  await b(workspace,'Open shared queue').click();
  const queue=reviewer.locator('#queue-view');
  await h(queue,'Work queue').waitFor();
  assert.equal(await queue.getByLabel('Queue owner').inputValue(),'all');
  await b(reviewer,'Home').click();
  await b(reviewer.locator('#home-view'),'Open Privacy Rights').click();
  await h(reviewer,'Privacy rights').first().waitFor();
  const admin=await browser.page();
  await browser.sign(admin,'identity-admin');
  await h(admin,'Workspace account roster').waitFor();
  assert.equal(await b(admin,'Home').count(),0);
  assert.equal(await admin.locator('#home-view').isHidden(),true);
  browser.end();
});

test('Chromium defers signed-in project state to assessments, retries in place, and resets it on a workspace switch',chrome,async t=>{
  const f=await fixture(t);
  for(const [workspace,name] of [['north','Fictional north project'],['south','Fictional south project']]){
    const cookie=await f.login('analyst',workspace);
    const {data}=await f.api('projects',{cookie,workspace,body:{name}});
    if(workspace==='south')await f.api('vendors',{cookie,workspace,body:{name:'Fictional south vendor',
      projectId:data.projects.find(row=>row.name===name).id,usesAI:false,handlesSensitiveData:false}});
  }
  const browser=await f.browser(),p=await browser.page();
  const home=p.locator('#home-view'),assessment=p.locator('#assessment-view');
  const stateRequests=[];
  let release,requested;
  const hold=new Promise(r=>{release=r;});
  const secondRequest=new Promise(r=>{requested=r;});
  await p.route(url=>url.pathname==='/api/state',async route=>{
    const workspace=new URL(route.request().url()).searchParams.get('workspace');
    stateRequests.push(workspace);
    if(stateRequests.length===1)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic temporary state fault"}'});
    if(stateRequests.length===2){requested();await hold;}
    return route.continue();
  });
  await browser.sign(p,'analyst');
  await h(home,'My next actions').waitFor();
  assert.deepEqual(stateRequests,[]);
  await b(home,'Refresh home summary').click();
  await h(home,'My next actions').waitFor();
  assert.deepEqual(stateRequests,[]);

  await b(p,'Assessments').click();
  await h(assessment,'Assessments unavailable').waitFor();
  assert.deepEqual(stateRequests,['north']);
  assert.equal(await b(assessment,'Create project').isDisabled(),true);
  assert.equal(await p.locator('#workbench').isVisible(),true);
  await b(assessment,'Retry assessments').click();
  try{
    await secondRequest;
    await see(assessment,'Loading assessments…');
    assert.equal(await b(assessment,'Create project').isDisabled(),true);
    const loaded=p.waitForResponse(response=>new URL(response.url()).pathname==='/api/state'&&response.ok());
    await b(p,'Home').click();
    await h(home,'My next actions').waitFor();
    release();
    await (await loaded).finished();
  }finally{release();}
  assert.equal(await assessment.isHidden(),true);
  await h(home,'My next actions').waitFor();
  await b(p,'Assessments').click();
  await h(assessment,'Fictional north project').waitFor();
  assert.deepEqual(stateRequests,['north','north']);
  await p.getByLabel('Project name',{exact:true}).fill('Fictional project added after assessment retry');
  await b(p,'Create project').click();
  await h(assessment,'Fictional project added after assessment retry').waitFor();

  await p.getByLabel('Workspace',{exact:true}).selectOption('south');
  await b(p,'Switch workspace').click();
  await h(home,'My next actions').waitFor();
  assert.deepEqual(stateRequests,['north','north']);
  await b(home,'Open shared queue').click();
  const queue=p.locator('#queue-view');
  const target=queue.getByRole('button',{name:/^Open record: Fictional south vendor/});
  await target.click();
  await h(assessment,'Fictional south project').waitFor();
  assert.equal(await assessment.locator('.assessment').evaluate(node=>node===document.activeElement),true);
  assert.deepEqual(stateRequests,['north','north','south']);
  assert.equal(await b(assessment,'Fictional north project').count(),0);
  browser.end();
});
