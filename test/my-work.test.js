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

async function fixture(t,isolated=true){
  const root=await mkdtemp(join(tmpdir(),'mvw-my-work-'));
  const roles=['analyst','reviewer','case-operator','publisher'];
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const server=(isolated?createServer({isolated:{
    root,
    workspaces:[{id:'alpha',label:'Synthetic Alpha'},{id:'beta',label:'Synthetic Beta'}],
    accounts:roles.map(role=>({id:'synthetic-'+role,codeHash:codeHash(codes[role]),memberships:{alpha:role,beta:role}}))
  }}):createServer({dataFile:join(root,'state.json')})).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
  const url='http://127.0.0.1:'+server.address().port;
  async function api(path,status,{cookie,body,workspace='alpha',headers={}}={}){
    const target=new URL('/api/'+path,url);
    if(workspace!==null)target.searchParams.set('workspace',workspace);
    const response=await fetch(target,{method:body===undefined?'GET':'POST',headers:{
      ...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...headers
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    assert.equal(response.status,status,JSON.stringify(data));
    return {response,data};
  }
  async function signIn(role,workspace='alpha'){
    const {response}=await api('session/login',200,{workspace:null,body:{account:'synthetic-'+role,workspace,code:codes[role]}});
    return response.headers.get('set-cookie').split(';')[0];
  }
  return {url,api,signIn,codes};
}

test('assigned staff work is authenticated, separated from global queues, and revoked when owner or action changes',async t=>{
  const {api,signIn}=await fixture(t);
  const analyst=await signIn('analyst'),reviewer=await signIn('reviewer'),operator=await signIn('case-operator'),other=await signIn('case-operator','beta'),publisher=await signIn('publisher');
  await api('my-work',401);
  await api('my-work',403,{cookie:publisher});
  await api('my-work',403,{cookie:other});
  await api('my-work/export',404,{cookie:operator});
  await api('work-queue',403,{cookie:operator});
  await api('audit/export',403,{cookie:operator});
  await api('my-work?owner=reviewer',422,{cookie:operator});
  const open=async(kind,owner,note)=>(await api('rights/cases',200,{cookie:analyst,body:{kind,owner,days:7,note}})).data.cases.find(x=>x.summary===note);
  const a=await open('access','case-operator','Synthetic first secret summary, not part of the queue.');
  const b=await open('correction','analyst','Synthetic other seat summary, not part of the queue.');
  const item=id=>'my-work/tasks/'+id;
  const list=async(cookie,workspace)=> (await api('my-work',200,{cookie,workspace})).data;
  assert.equal((await list(operator)).tasks.length,0);
  const review=await list(reviewer);
  assert.equal(review.tasks.length,2);
  assert.ok(review.tasks.every(x=>x.actionLabel==='Review identity independently'&&x.timing==='upcoming'&&x.dueDate));
  const staleReview=review.tasks.find(x=>x.recordLabel==='access request').key;
  await api(item(staleReview),404,{cookie:operator});
  const right=async(row,action,revision,cookie)=>api('rights/cases/'+row.id+'/'+action,200,{cookie,body:{expectedRevision:revision,note:'Fictional lifecycle detail'}});
  await right(a,'verify',1,reviewer);
  await right(b,'verify',1,reviewer);
  assert.equal((await list(reviewer)).tasks.length,0);
  await api(item(staleReview),404,{cookie:reviewer});
  const own=await list(operator);
  assert.deepEqual(Object.keys(own),['asOf','tasks']);
  assert.equal(own.tasks.length,1);
  const [task]=own.tasks;
  assert.deepEqual(Object.keys(task),['key','workflow','workflowName','actionLabel','recordLabel','dueDate','timing']);
  assert.match(task.key,/^[a-f0-9]{64}$/);
  assert.equal(task.recordLabel,'access request');
  assert.equal(task.actionLabel,'Begin mock fulfillment');
  assert.equal(task.dueDate,a.dueDate);
  assert.doesNotMatch(JSON.stringify(own),/secret summary|correction|createdBy|sourceId|actor|audit\W|case(?:Id|s)\W/i);
  const overridden=await api('my-work',200,{cookie:operator,headers:{'X-Demo-Actor':'reviewer'}});
  assert.deepEqual(overridden.data,own);
  assert.deepEqual((await api(item(task.key),200,{cookie:operator})).data,{destination:{view:'rights',recordId:a.id}});
  await api(item(task.key),404,{cookie:reviewer});
  await api(item(task.key),404,{cookie:analyst});
  await api(item(task.key),404,{cookie:other,workspace:'beta'});
  assert.equal((await list(other,'beta')).tasks.length,0);
  await api('rights/cases/'+a.id+'/assign',200,{cookie:analyst,body:{expectedRevision:2,note:'Synthetic handover',owner:'analyst'}});
  await api(item(task.key),404,{cookie:operator});
  assert.equal((await list(operator)).tasks.length,0);
  assert.deepEqual((await list(analyst)).tasks.map(t=>t.recordLabel).sort(),['access request','correction request']);
});
test('demo mode does not expose personal work or accept synthetic identity header to enable it',async t=>{
  const {api}=await fixture(t,false);
  await api('my-work',404,{workspace:null,headers:{'X-Demo-Actor':'analyst'}});
});

test('browser My Work displays only assigned case actions and deep-link focus revalidates after state changes',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Requires Playwright and Chromium',timeout:35000
},async t=>{
  const {url,api,signIn,codes}=await fixture(t);
  const author=await signIn('analyst');
  await api('rights/cases',200,{cookie:author,body:{kind:'access',owner:'case-operator',days:5,note:'Fictional delegated case'}});
  await api('rights/cases',200,{cookie:author,body:{kind:'correction',owner:'analyst',days:5,note:'Fictional other seat'}});
  const privacyDraft=(await api('governance-documents/records',200,{cookie:author,body:{
    kind:'policy',title:'Fictional assigned policy step',content:'Synthetic content only',links:[],expectedRevision:0
  }})).data.documents[0];
  await api('governance-documents/records/'+privacyDraft.id+'/revisions/'+privacyDraft.revisions[0].id+'/submit',200,{
    cookie:author,body:{expectedRevision:1}
  });
  const control=(await api('risk-controls/controls',200,{cookie:author,body:{
    title:'Fictional assigned control',intent:'Fictional control only',expectedRevision:0
  }})).data.controls[0];
  await api('audit-management/plans',200,{cookie:author,body:{
    title:'Fictional assigned audit step',objective:'Synthetic audit objective',scope:'Synthetic plan scope',controlIds:[control.id]
  }});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const errors=[];
  const pageFor=async role=>{
    const page=await browser.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(7500);
    await page.goto(url);
    await page.getByLabel('Test account',{exact:true}).fill('synthetic-'+role);
    await page.getByLabel('Workspace ID',{exact:true}).fill('alpha');
    await page.getByLabel('Local access code',{exact:true}).fill(codes[role]);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'My work',exact:true}).click();
    await page.getByRole('heading',{name:'Assigned work',exact:true}).waitFor();
    return page;
  };
  const reviewer=await pageFor('reviewer'),operator=await pageFor('case-operator'),analyst=await pageFor('analyst');
  await analyst.getByRole('link',{name:/^Open assigned record: Fictional assigned audit step/}).click();
  await analyst.locator('#audit-management-view article:focus').getByRole('heading',{name:'Fictional assigned audit step',exact:true}).waitFor();
  await reviewer.getByRole('link',{name:/^Open assigned record: Fictional assigned policy step/}).click();
  await reviewer.locator('#governance-docs-view section:focus').getByRole('heading',{name:'Fictional assigned policy step',exact:true}).waitFor();
  await reviewer.getByRole('button',{name:'My work',exact:true}).click();

  await operator.getByText('No open tasks are assigned to you.',{exact:true}).waitFor();
  assert.equal(await operator.getByRole('button',{name:'Work queue',exact:true}).isVisible(),false);
  assert.equal(await reviewer.getByRole('link',{name:'Export audit JSON',exact:true}).isVisible(),false);
  const reviewLink=reviewer.getByRole('link',{name:/^Open assigned record: access request/});
  const copied=await reviewLink.getAttribute('href');
  await reviewLink.click();
  const focusedReview=reviewer.locator('#rights-view article:focus');
  await focusedReview.getByRole('heading',{name:'Access case',exact:true}).waitFor();
  const reviewPanel=reviewer.locator('#rights-view article').filter({has:reviewer.getByRole('heading',{name:'Access case',exact:true})}).locator('details').filter({has:reviewer.locator('summary').filter({hasText:/^Mark identity verified$/})});
  await reviewPanel.locator('summary').click();
  await reviewPanel.getByLabel('Fictional action note',{exact:true}).fill('Fictional identity confirmed.');
  await reviewPanel.getByRole('button',{name:'Mark identity verified',exact:true}).click();
  await reviewer.locator('#rights-view').getByText('Identity: verified',{exact:true}).waitFor();
  await operator.getByRole('button',{name:'Refresh my work',exact:true}).click();
  const begin=operator.getByRole('link',{name:/^Open assigned record: access request.*Begin mock fulfillment/});
  await begin.waitFor();
  assert.equal(await operator.locator('#my-work-view article').count(),1);
  assert.equal(await operator.getByText(/correction request/).count(),0);
  const saved=await begin.getAttribute('href');
  await begin.click();
  await operator.locator('#rights-view article:focus').getByRole('heading',{name:'Access case',exact:true}).waitFor();
  await operator.reload();
  const focusedCase=operator.locator('#rights-view article:focus');
  await focusedCase.getByRole('heading',{name:'Access case',exact:true}).waitFor();
  const beginPanel=operator.locator('#rights-view article details').filter({has:operator.locator('summary').filter({hasText:/^Begin fulfillment$/})});
  await beginPanel.locator('summary').click();
  await beginPanel.getByLabel('Fictional action note',{exact:true}).fill('Fictional fulfillment started.');
  await beginPanel.getByRole('button',{name:'Begin fulfillment',exact:true}).click();
  await operator.locator('#rights-view article').getByText('in progress',{exact:true}).waitFor();
  assert.match(operator.url(),new RegExp(saved+'$'));
  await operator.reload();
  await operator.getByText('This work item is no longer assigned to you.',{exact:true}).waitFor();
  await operator.getByRole('link',{name:/Document mock fulfillment/}).waitFor();
  await operator.goto(url+'/'+copied);
  await operator.getByText('This work item is no longer assigned to you.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});
