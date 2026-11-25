'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const freshCode=()=>randomBytes(32).toString('base64url');

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'mvw-trust-policy-'));
  const controls={now:Date.now()};
  const codes={};
  function account(name,memberships,extra={}){
    codes[name]=freshCode();
    return {id:name,codeHash:codeHash(codes[name]),memberships,...extra};
  }
  const isolated={root,now:()=>controls.now,sessionSeconds:90,workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:[
      account('analyst',{alpha:'analyst',beta:'reviewer'}),
      account('reviewer',{alpha:'reviewer'}),
      account('publisher',{alpha:'publisher'}),
      account('operator',{alpha:'case-operator'}),
      account('limited',{beta:'analyst'},{validUntil:controls.now+40000}),
      account('disabled',{beta:'publisher'},{disabled:true}),
    ]};
  const server=createServer({isolated}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
  async function request(route,expected,{token,body,workspace='alpha',method=body===undefined?'GET':'POST',demo='reviewer'}={}){
    const target=url+'/api/'+route+(workspace?(route.includes('?')?'&':'?')+'workspace='+workspace:'');
    const headers={'X-Demo-Actor':demo,...(token?{Cookie:token}:{})};
    if(body!==undefined)Object.assign(headers,{Origin:url,'Content-Type':'application/json'});
    const response=await fetch(target,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,expected,method+' '+route+': '+await response.clone().text());
    return {data:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  async function login(id,workspace='alpha',expected=200,token){
    const response=await request('session/login',expected,{token,workspace:null,body:{account:id,code:codes[id],workspace}});
    return {token:response.cookie?.split(';')[0],...response};
  }
  return {root,controls,request,login,url};
}

test('isolated workbench fails closed by route and role while keeping scope and domain transitions',async t=>{
  const {root,request,login}=await fixture(t);
  const a=(await login('analyst')).token,r=(await login('reviewer')).token;
  const p=await login('publisher'), c=await login('operator');
  assert.deepEqual(p.data.capabilities,{views:['workflow-studio'],workspaceAudit:false});
  assert.deepEqual(c.data.capabilities,{views:['rights','my-work','governance-docs'],workspaceAudit:false});
  for(const route of ['state/export','future-feature','workflows/studio/missing/secret'])await request(route,404,{token:a});
  assert.deepEqual(await readdir(join(root,'alpha')),[]);
  await request('dictionary/terms',404,{token:a,method:'DELETE'});
  await request('state',403,{token:c.token,workspace:'beta'});
  await request('audit/export',403,{token:a});
  for(const token of [p.token,c.token]){
    for(const route of ['audit/export','work-queue','work-queue/export','audit-management','incidents/cases','risk-controls/export','data-map/export',
      'dictionary/export','modules','employee-attestations','trust-center','reporting','reporting/export'])await request(route,403,{token});
    await request('projects',403,{token,body:{name:'Project'}});  // a forged demo role grants nothing
  }
  const created=(await request('projects',200,{token:a,body:{name:'Project scoped state'}})).data;
  assert.deepEqual(Object.keys(created).sort(),['actors','assessments','audit','handoff','projects','vendors','version']);
  assert.ok(created.audit.some(e=>e.action==='project.created'));
  const rights='rights/cases';
  const outside=(await request(rights,200,{token:a,body:{kind:'access',owner:'analyst',days:30,note:'UNASSIGNED-CASE-NOTE'}})).data.cases[0];
  const owned=(await request(rights,200,{token:a,body:{kind:'correction',owner:'case-operator',days:30,note:'OWN-CASE-NOTE'}})).data.cases.find(x=>x.owner==='case-operator');
  const scoped=(await request(rights,200,{token:c.token})).data;
  assert.deepEqual(scoped.cases.map(x=>x.id),[owned.id]);
  assert.doesNotMatch(JSON.stringify(scoped),/UNASSIGNED-CASE-NOTE/);
  await request(rights+'/'+outside.id+'/begin',404,{token:c.token,body:{expectedRevision:1,note:'Refused'}});
  await request(rights+'/'+owned.id+'/verify',403,{token:c.token,body:{expectedRevision:1,note:'Refused'}});
  await request(rights+'/'+owned.id+'/verify',200,{token:r,body:{expectedRevision:1,note:'Verified'}});
  const started=await request(rights+'/'+owned.id+'/begin',200,{token:c.token,body:{expectedRevision:2,note:'Case operator work'}});
  assert.deepEqual(started.data.cases.map(x=>x.id),[owned.id]);  // mutation response is also projected
  assert.equal(started.data.cases[0].status,'in-progress');
  const documents='governance-documents';
  async function evidence(caseId,revision,title){
    const book=(await request(documents+'/records',200,{token:a,body:{expectedRevision:revision,
      kind:'evidence',title,content:'TEST-EDITION-BODY-'+title,links:[{type:'rights-case',id:caseId}]}})).data;
    const doc=book.documents.find(doc=>doc.revisions[0].title===title);
    const edition=documents+'/records/'+doc.id+'/revisions/'+doc.revisions[0].id;
    await request(edition+'/submit',200,{token:a,body:{expectedRevision:revision+1}});
    await request(edition+'/publish',200,{token:r,body:{expectedRevision:revision+2,note:'REVIEWER-NOTE-PRIVATE'}});
    return {id:doc.id,edition};
  }
  const external=await evidence(outside.id,0,'Outside edition');
  const assigned=await evidence(owned.id,3,'Assigned edition');
  const catalog=(await request(documents,200,{token:c.token})).data;
  assert.deepEqual(catalog.documents.map(d=>d.id),[assigned.id]);
  assert.doesNotMatch(JSON.stringify(catalog),/REVIEWER-NOTE-PRIVATE|Outside edition/);
  const downloaded=(await request(assigned.edition+'/download',200,{token:c.token,body:{}})).data;
  assert.equal(downloaded.text,'TEST-EDITION-BODY-Assigned edition');
  assert.doesNotMatch(JSON.stringify(downloaded),/REVIEWER-NOTE-PRIVATE/);
  await request(external.edition+'/read',404,{token:c.token,body:{}});
  const workspaceState=(await request('state',200,{token:a})).data;
  assert.doesNotMatch(JSON.stringify(workspaceState),/UNASSIGNED-CASE-NOTE|OWN-CASE-NOTE/);
  assert.deepEqual((await request('state',200,{token:p.token})).data.projects,[]);
  const audit=(await request('audit/export',200,{token:r})).data.audit;
  assert.ok(audit.some(e=>e.action==='rights.case.opened'));
  assert.ok(audit.some(e=>e.action==='rights.case.begin'&&e.account==='operator'));
});
test('isolated publisher can publish definitions without being granted instance fields or raw audit',async t=>{
  const {request,login}=await fixture(t);
  const a=(await login('analyst')).token,r=(await login('reviewer')).token,p=(await login('publisher')).token;
  const recipe=(await request('workflows/studio',200,{token:p})).data.recipes[0];
  const row=recipe.transitions[0];
  const invalid={...recipe,transitions:[{...row,roles:['publisher']},...recipe.transitions.slice(1)]};
  const rejected=await request('workflows/definitions',422,{token:p,body:{definition:invalid,expectedVersion:0}});
  assert.equal(rejected.data.code,'WORKFLOW_ROLE_UNAVAILABLE');
  await request('workflows/definitions',403,{token:a,body:{definition:recipe,expectedVersion:0}});
  assert.equal((await request('workflows/definitions',200,{token:p,body:{definition:recipe,expectedVersion:0}})).data.ok,true);
  const instance=(await request('workflows/instances',200,{token:a,body:{definitionId:recipe.id,version:1,title:'PRIVATE-INSTANCE-TITLE'}})).data.instance;
  await request('workflows/instances/'+instance.id,403,{token:p});
  await request('workflows/studio/'+instance.id,403,{token:p});
  await request('workflows/audit',403,{token:p});
  const studio=(await request('workflows/studio',200,{token:p})).data;
  assert.deepEqual(studio.instances,[]);
  assert.equal(studio.selected,null);
  assert.doesNotMatch(JSON.stringify(studio),/PRIVATE-INSTANCE-TITLE/);
  assert.ok(studio.recentAudit.every(e=>e.kind.startsWith('definition.')));
  assert.equal((await request('workflows/instances/'+instance.id,200,{token:r})).data.title,'PRIVATE-INSTANCE-TITLE');
  assert.ok((await request('workflows/audit',200,{token:r})).data.audit.length);
});
test('account validity bounds bearer sessions and switching, and disabled accounts cannot sign in',async t=>{
  const {request,login,controls}=await fixture(t);
  const at=controls.now;
  const first=await login('limited','beta');
  assert.match(first.cookie,/Max-Age=40;/);
  const notAllowed=await login('disabled','beta',401);
  assert.equal(notAllowed.cookie,null);
  controls.now=at+39000;
  const switched=await request('session/switch',200,{token:first.token,workspace:null,body:{current:'beta',workspace:'beta'}});
  assert.match(switched.cookie,/Max-Age=1;/);
  await request('state',401,{token:first.token,workspace:'beta'});
  const next=switched.cookie.split(';')[0];
  await request('state',200,{token:next,workspace:'beta'});
  controls.now=at+40000;
  await request('state',401,{token:next,workspace:'beta'});
  await login('limited','beta',401);
  const sessions=await Promise.all(Array.from({length:8},()=>login('analyst')));
  await login('analyst','alpha',429);
  await login('analyst','alpha',200,sessions[0].token);
});

test('browser opens isolated publisher and case-operator views without exposing unavailable navigation',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000
},async t=>{
  const {chromium}=require('playwright');
  const {url,login}=await fixture(t);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    for(const [id,heading,button,forbidden] of [
      ['publisher','Workflow studio','Workflow studio','Privacy rights'],
      ['operator','Privacy rights','Privacy rights','Workflow studio'],
    ]){
      const auth=await login(id);
      const page=await browser.newPage();
      await page.context().addCookies([{name:auth.token.split('=')[0],value:auth.token.split('=')[1],url,httpOnly:true,sameSite:'Strict'}]);
      await page.goto(url);
      await page.getByRole('heading',{name:heading,level:1}).waitFor({timeout:6000});
      assert.equal(await page.getByRole('button',{name:button,exact:true}).isVisible(),true);
      assert.equal(await page.getByRole('button',{name:forbidden,exact:true}).count(),0);
      assert.equal(await page.locator('#audit-export').isVisible(),false);
      await page.close();
    }
  }finally{await browser.close()}
});
