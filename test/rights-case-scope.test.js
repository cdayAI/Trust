'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');

const main='harbor',other='orchard';
const browserEnabled=process.env.RUN_BROWSER_SMOKE==='1';
const note='Fictional case summary not visible to an unbound operator.';
async function setup(t,{sqlite=false,documents=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'mvw-rights-case-scope-')),codes={};
  let server,url,now=Date.now();
  function provision(role,id='sample-'+role){
    const code=codes[role]=randomBytes(32).toString('base64url');
    return {id,codeHash:codeHash(code),memberships:{[main]:role,[other]:role}};
  }
  const options={sqliteFile:sqlite?join(dir,'workbench.sqlite'):undefined,isolated:{
    root:join(dir,'workspaces'),now:()=>now,rightsCaseScopeWorkspaces:[main,other],enableIdentityAdmin:true,
    ...(documents?{documentScopeWorkspaces:[main]}:{}),
    workspaces:[main,other].map(id=>({id,label:'Sample '+id})),
    accounts:['analyst','reviewer','case-operator','identity-admin'].map(role=>provision(role))
  }};
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
  async function start(){server=createServer(options).listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});await start();
  async function api(route,status,{token,space=main,body,origin=url,headers={}}={}){
    const response=await fetch(url+'/api/'+route+(space===null?'':'?workspace='+space),{
      method:body===undefined?'GET':'POST',headers:{
        'X-Demo-Actor':'analyst',...(token?{Cookie:token}:{}),
        ...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    const raw=await response.text(),data=JSON.parse(raw);
    assert.equal(response.status,status,route+' '+raw);
    return {data,raw,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(role,space=main,id='sample-'+role)=>(await api('session/login',200,
    {space:null,body:{account:id,workspace:space,code:codes[role]}})).cookie;
  const create=async(token,summary=note)=>(await api('rights/cases',200,{token,
    body:{kind:'access',owner:'case-operator',days:30,note:summary}})).data.cases.at(-1);
  const apply=async(id,token,action,revision,body={},status=200,space=main)=>api('rights/cases/'+id+'/'+action,status,
    {token,space,body:{expectedRevision:revision,...body}});
  const delegate=(id,token,revision,status=200,account='sample-case-operator')=>
    apply(id,token,'delegation',revision,{operation:'delegate',reason:'case-assignment',account},status);
  const revoke=(id,token,revision,status=200)=>apply(id,token,'delegation',revision,{operation:'revoke',reason:'assignment-ended'},status);
  const cases=(token,space=main)=>api('rights/cases',200,{token,space});
  return {options,codes,api,login,create,apply,delegate,revoke,cases,withClock:ms=>{now+=ms;},
    get url(){return url;},async restart(){await stop();await start();},replaceSeat(){
      const i=options.isolated.accounts.findIndex(a=>a.id==='sample-case-operator');
      options.isolated.accounts[i]=provision('case-operator','sample-replacement');
    }};
}
test('role assignment alone reveals nothing through list, commands, task tokens or dashboard',async t=>{
  const f=await setup(t);
  const a=await f.login('analyst'),r=await f.login('reviewer'),o=await f.login('case-operator'),otherOperator=await f.login('case-operator',other);
  const first=await f.create(a),second=await f.create(a,'Fictional separately withheld case.');
  await f.apply(first.id,r,'verify',1,{note:'Verified synthetic fixture.'});
  await f.apply(second.id,r,'verify',1,{note:'Verified synthetic fixture.'});
  assert.equal((await f.cases(r)).data.cases.length,2);
  assert.equal((await f.cases(r)).data.delegation,undefined);
  assert.deepEqual((await f.cases(o)).data.cases,[]);
  assert.deepEqual((await f.api('my-work',200,{token:o})).data.tasks,[]);
  assert.equal((await f.api('workspace-home',200,{token:o})).data.assigned.total,0);
  const denied=await f.apply(first.id,o,'begin',2,{note:'Denied.'},404);
  assert.deepEqual(denied.data,(await f.apply(randomUUID(),o,'begin',2,{note:'Denied.'},404)).data);
  await f.delegate(first.id,r,2,403);await f.delegate(first.id,o,2,403);
  await f.delegate(first.id,a,2,422,'sample-reviewer');
  const delegated=(await f.delegate(first.id,a,2)).data;
  assert.equal(delegated.delegation.cases.find(row=>row.id===first.id).status,'active');
  assert.equal(delegated.delegation.cases.find(row=>row.id===second.id).status,'not-delegated');
  await f.revoke(first.id,a,2,409);
  const visible=(await f.cases(o)).data;
  assert.deepEqual(visible.cases.map(row=>row.id),[first.id]);
  assert.equal(visible.delegation,undefined);
  assert.doesNotMatch(JSON.stringify(visible),/separately withheld|binding/);
  assert.equal((await f.api('workspace-home',200,{token:o})).data.assigned.total,1);
  const work=(await f.api('my-work',200,{token:o})).data.tasks;
  assert.equal(work.length,1);
  const taskUrl='my-work/tasks/'+work[0].key;
  assert.equal((await f.api(taskUrl,200,{token:o})).data.destination.recordId,first.id);
  await f.api(taskUrl,404,{token:otherOperator,space:other});
  await f.apply(first.id,o,'begin',3,{note:'Began delegated work.'});
  await f.apply(second.id,o,'begin',2,{note:'Denied.'},404);
  await f.revoke(first.id,a,4);
  assert.deepEqual((await f.cases(o)).data.cases,[]);
  await f.api(taskUrl,404,{token:o});
  await f.apply(first.id,o,'fulfill',5,{note:'Denied after revoke.'},404);
  const audit=(await f.api('audit/export',200,{token:r})).data.audit;
  assert.deepEqual(audit.filter(row=>row.action.startsWith('rights.case.account-')).map(row=>[row.action,row.account,row.entityId]),
    [['rights.case.account-delegated','sample-analyst',first.id],['rights.case.account-revoked','sample-analyst',first.id]]);
});

for(const sqlite of [false,true])test(`delegation survives ${sqlite?'SQLite':'JSON'} restart but expires and never transfers to replacement seats or downgraded config`,async t=>{
  const f=await setup(t,{sqlite});
  let a=await f.login('analyst'),o=await f.login('case-operator');
  const c=await f.create(a);
  await f.delegate(c.id,a,1);
  await f.restart();
  await f.api('rights/cases',401,{token:o});
  o=await f.login('case-operator');a=await f.login('analyst');
  assert.equal((await f.cases(o)).data.cases.length,1);
  f.withClock(31*86400000);
  o=await f.login('case-operator');a=await f.login('analyst');
  assert.equal((await f.cases(o)).data.cases.length,0);
  assert.equal((await f.cases(a)).data.delegation.cases[0].status,'expired');
  await f.delegate(c.id,a,2);
  f.replaceSeat();await f.restart();
  o=await f.login('case-operator',main,'sample-replacement');a=await f.login('analyst');
  assert.equal((await f.cases(o)).data.cases.length,0);
  assert.equal((await f.cases(a)).data.delegation.cases[0].status,'stale');
  await f.delegate(c.id,a,3,200,'sample-replacement');
  assert.equal((await f.cases(o)).data.cases.length,1);
  delete f.options.isolated.rightsCaseScopeWorkspaces;
  await f.restart();
  o=await f.login('case-operator',main,'sample-replacement');a=await f.login('analyst');
  assert.deepEqual((await f.cases(o)).data.cases,[]);
  assert.equal((await f.cases(a)).data.cases.length,1);
  await f.apply(c.id,o,'begin',4,{note:'Configuration cannot broaden access.'},404);
});

test('published linked evidence needs case delegation and a separate document grant; reassignment never reuses approvals',async t=>{
  const f=await setup(t,{documents:true});
  const [a,r,m,o]=await Promise.all(['analyst','reviewer','identity-admin','case-operator'].map(role=>f.login(role)));
  const c=await f.create(a);
  const api=(path,status,token,body)=>f.api(path,status,{token,body});
  const {data:created}=await api('governance-documents/records',200,a,{kind:'evidence',title:'Fictional delegated evidence',
    content:'Fictional evidence bytes',links:[{type:'rights-case',id:c.id}],expectedRevision:0});
  const d=created.documents[0],e=d.revisions[0],path='governance-documents/records/'+d.id+'/revisions/'+e.id;
  await api(path+'/submit',200,a,{expectedRevision:1});
  await api(path+'/publish',200,r,{expectedRevision:2,note:'Reviewed synthetic policy.'});
  const docs=async()=> (await api('governance-documents',200,o)).data.documents;
  const propose=(revision,status)=>api('document-access',status,r,{operation:'propose',account:'sample-case-operator',
    document:d.id,edition:e.id,level:'text',expectedRevision:revision,reason:'operational-need'});
  assert.deepEqual(await docs(),[]);
  await propose(0,404);
  await f.delegate(c.id,a,1);
  const proposed=await propose(0,200),grant=proposed.data.grants[0].id;
  await api('document-access',200,m,{operation:'approve',grant,expectedRevision:1,reason:'scope-review'});
  assert.equal((await docs()).length,1);
  await api(path+'/read',200,o,{});
  await f.apply(c.id,a,'assign',2,{owner:'analyst',note:'Synthetic transition off operator.'});
  await f.apply(c.id,a,'assign',3,{owner:'case-operator',note:'Synthetic transition back.'});
  assert.equal((await f.cases(o)).data.cases.length,0);
  await f.delegate(c.id,a,4);
  assert.equal((await f.cases(o)).data.cases.length,1);
  assert.deepEqual(await docs(),[]);
  await api(path+'/read',404,o,{});
  assert.equal((await api('document-access',200,m)).data.grants[0].status,'stale');
});

test('Chromium: analyst grants and revokes a case and the signed-in case operator can only read it during delegation',{
  skip:!browserEnabled&&'Set RUN_BROWSER_SMOKE=1 with Playwright and Chromium',timeout:30000
},async t=>{
  const {chromium}=require('playwright');const f=await setup(t),a=await f.login('analyst');
  await f.create(a);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function pageFor(role){
      const page=await browser.newPage();page.setDefaultTimeout(5000);await page.goto(f.url);
      await page.getByLabel('Test account').fill('sample-'+role);await page.getByLabel('Workspace ID').fill(main);
      await page.getByLabel('Local access code').fill(f.codes[role]);await page.getByRole('button',{name:'Sign in',exact:true}).click();
      return page;
    }
    const analyst=await pageFor('analyst'),operator=await pageFor('case-operator');
    const open=page=>page.locator('#show-rights').click();
    await open(operator);await operator.getByText('No rights cases yet.',{exact:true}).waitFor();
    await open(analyst);const rights=analyst.locator('#rights-view');
    await rights.locator('summary').filter({hasText:'Account access'}).click();
    await rights.getByLabel('Specific local case operator').selectOption('sample-case-operator');
    await rights.getByLabel('Confirm delegation of this exact case.').check();
    await rights.getByRole('button',{name:'Delegate this case',exact:true}).click();
    await analyst.getByText('Privacy rights case updated.',{exact:true}).waitFor();
    await open(operator);await operator.getByText(note,{exact:true}).waitFor();
    assert.equal(await operator.locator('summary').filter({hasText:'Account access'}).count(),0);
    await rights.locator('summary').filter({hasText:'Account access'}).click();
    await rights.getByLabel('Confirm revocation of this case delegation.').check();
    await rights.getByRole('button',{name:'Revoke case access',exact:true}).click();
    await analyst.getByText('Privacy rights case updated.',{exact:true}).waitFor();
    await open(operator);await operator.getByText('No rights cases yet.',{exact:true}).waitFor();
  }finally{await browser.close();}
});

const rightsVersion='X-MVW-Rights-View-Version';
const preferMinimal={Prefer:'return=minimal'};
const newCaseBody=note=>({kind:'access',owner:'case-operator',days:30,note});
for(const sqlite of [false,true])test('staff intake prefers a single exact projection without widening case scope, with stale full fallback in '+(sqlite?'SQLite':'JSON'),async t=>{
  const f=await setup(t,{sqlite});
  let author=await f.login('analyst'),reviewer=await f.login('reviewer'),operator=await f.login('case-operator');
  await f.create(author,'Existing fictional case should not be repeated in the response.');
  const request=(body,status=200,headers={},token=author,space=main)=>
    f.api('rights/cases',status,{token,space,body,headers});
  const model=await f.cases(author),before=model.headers.get(rightsVersion);
  assert.match(before,/^[a-f0-9]{64}$/);
  assert.equal((await f.cases(reviewer)).headers.has(rightsVersion),false);
  await request(newCaseBody('Not opened'),403,preferMinimal,operator);
  await request(newCaseBody('Not opened'),403,preferMinimal,reviewer);
  const created=await request(newCaseBody('A fictional minimal intake'),201,{...preferMinimal,[rightsVersion]:before});
  assert.equal(created.headers.get('Preference-Applied'),'return=minimal');
  assert.equal(created.data.case.revision,1);
  assert.equal(created.data.case.history[0].account,'sample-analyst');
  assert.equal(created.data.delegation.status,'not-delegated');
  assert.equal(created.data.baseVersion,before);
  assert.equal(Object.hasOwn(created.data,'cases'),false);
  assert.doesNotMatch(created.raw,/Existing fictional case/);
  const list=await f.cases(author);
  assert.deepEqual(list.data.cases.at(-1),created.data.case);
  assert.deepEqual(list.data.delegation.cases.at(-1),created.data.delegation);
  assert.equal(created.headers.get(rightsVersion),list.headers.get(rightsVersion));
  assert.deepEqual((await f.cases(operator)).data.cases,[]);

  const pendingVersion=list.headers.get(rightsVersion);
  await f.apply(created.data.case.id,reviewer,'verify',1,{note:'Independent synthetic verification.'});
  const stale=await request(newCaseBody('A concurrent synthetic case'),200,{...preferMinimal,[rightsVersion]:pendingVersion});
  assert.equal(stale.headers.has('Preference-Applied'),false);
  assert.equal(stale.data.cases.length,3);
  assert.equal(stale.data.cases.find(row=>row.id===created.data.case.id).revision,2);
  assert.equal(stale.data.cases.find(row=>row.id===created.data.case.id).identity.status,'verified');
  assert.match(stale.headers.get(rightsVersion),/^[a-f0-9]{64}$/);
  const nonConditional=await request(newCaseBody('API-only minimal projection'),201,preferMinimal);
  assert.equal(nonConditional.data.baseVersion,null);
  assert.equal(nonConditional.headers.has(rightsVersion),false);
  const oldContract=await request(newCaseBody('Traditional full response'));
  assert.equal(oldContract.data.cases.length,5);
  assert.equal(oldContract.headers.has('Preference-Applied'),false);
  const conflicting=await request(newCaseBody('Conflicting optional preference'),200,
    {Prefer:'return=minimal, return=representation'});
  assert.equal(conflicting.data.cases.length,6);
  assert.equal(conflicting.headers.has('Preference-Applied'),false);

  const grant=await f.delegate(created.data.case.id,author,2);
  assert.equal(grant.data.delegation.cases.find(row=>row.id===created.data.case.id).status,'active');
  const preExpiry=(await f.cases(author)).headers.get(rightsVersion);
  f.withClock(31*86400000);
  author=await f.login('analyst');operator=await f.login('case-operator');
  const expiryFallback=await request(newCaseBody('New case after lease expiry'),200,{...preferMinimal,[rightsVersion]:preExpiry});
  assert.equal(expiryFallback.headers.has('Preference-Applied'),false);
  assert.equal(expiryFallback.data.delegation.cases.find(row=>row.id===created.data.case.id).status,'expired');
  assert.deepEqual((await f.cases(operator)).data.cases,[]);

  const otherAuthor=await f.login('analyst',other);
  const otherResult=await request(newCaseBody('Other workspace only'),200,
    {...preferMinimal,[rightsVersion]:expiryFallback.headers.get(rightsVersion)},otherAuthor,other);
  assert.equal(otherResult.data.cases.length,1);
  assert.doesNotMatch(otherResult.raw,/A fictional minimal intake|Existing fictional case/);
});

test('Chromium opens one new scoped rights card, full-refreshes on conflict, and reloads rather than reposting after a lost response',{
  skip:!browserEnabled&&'Set RUN_BROWSER_SMOKE=1 with Playwright and Chromium',timeout:40_000
},async t=>{
  const f=await setup(t,{sqlite:true}),author=await f.login('analyst'),reviewer=await f.login('reviewer');
  const existing=await f.create(author,'Existing fictional browser card');
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[],external=[],rightsReads=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(7500);
  await page.route('**/*',route=>{
    const endpoint=new URL(route.request().url());
    if(endpoint.origin!==f.url){external.push(endpoint.origin);return route.abort();}
    if(endpoint.pathname==='/api/rights/cases'&&route.request().method()==='GET')rightsReads.push(endpoint.searchParams.get('workspace'));
    return route.continue();
  });
  await page.goto(f.url);
  await page.getByLabel('Test account',{exact:true}).fill('sample-analyst');
  await page.getByLabel('Workspace ID',{exact:true}).fill(main);
  await page.getByLabel('Local access code',{exact:true}).fill(f.codes.analyst);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Privacy rights',exact:true}).click();
  const pane=page.locator('#rights-view'),original=pane.locator('#work-record-'+existing.id);
  await original.getByText('Existing fictional browser card',{exact:true}).waitFor();
  await original.evaluate(node=>{window.rightsFixtureOriginal=node;});
  const submit=pane.getByRole('button',{name:'Open rights case',exact:true});
  const short=pane.getByLabel('Fictional intake note',{exact:true});
  await pane.getByLabel('Assigned owner').selectOption('case-operator');
  async function create(note){
    await short.fill(note);
    const [response]=await Promise.all([page.waitForResponse(res=>new URL(res.url()).pathname==='/api/rights/cases'&&
      res.request().method()==='POST'),submit.click()]);
    await pane.locator('article').getByText(note,{exact:true}).waitFor();
    return response;
  }
  const minimal=await create('Fictional delta browser intake');
  const row=(await minimal.json()).case;
  assert.equal(minimal.status(),201);
  assert.equal(minimal.headers()['preference-applied'],'return=minimal');
  assert.equal(minimal.request().headers().prefer,'return=minimal');
  assert.equal(await original.evaluate(node=>node===window.rightsFixtureOriginal),true);
  assert.equal(await short.inputValue(),'');
  assert.deepEqual(rightsReads,[main]);
  const newCard=pane.locator('#work-record-'+row.id);
  await newCard.getByText('Account access',{exact:true}).click();
  await newCard.getByText('Delegation: not delegated',{exact:true}).waitFor();

  await f.apply(existing.id,reviewer,'verify',1,{note:'Independent fictional concurrent update.'});
  const full=await create('Fictional stale browser intake');
  assert.equal(full.status(),200);
  assert.equal(full.headers()['preference-applied'],undefined);
  await original.getByText('Identity: verified',{exact:true}).waitFor();
  assert.deepEqual(rightsReads,[main]);
  let committed;
  await page.route(url=>url.pathname==='/api/rights/cases',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    committed=await route.fetch();
    await route.abort('connectionreset');
  },{times:1});
  await short.fill('Fictional committed case with dropped response');
  await submit.click();
  await page.locator('#notice').filter({hasText:/The intake result could not be confirmed\. Reload cases before submitting again\./u}).waitFor();
  assert.equal(await submit.isDisabled(),true);assert.equal(committed.status(),201);
  await page.getByRole('button',{name:'Reload cases',exact:true}).click();
  await pane.locator('article').getByText('Fictional committed case with dropped response',{exact:true}).waitFor();
  assert.equal(await pane.locator('article').getByText('Fictional committed case with dropped response',{exact:true}).count(),1);
  assert.equal(await submit.isEnabled(),true);
  assert.deepEqual(rightsReads,[main,main]);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
