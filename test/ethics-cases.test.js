'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {readFile,mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const account=(id,memberships)=>({id,memberships,code:randomBytes(32).toString('base64url')});
const accounts=()=>[
  account('sample-ethics-investigator',{alpha:'ethics-investigator'}),
  account('sample-ethics-reviewer',{alpha:'ethics-reviewer'}),
  account('sample-reviewer',{alpha:'reviewer'}),
  account('sample-beta-ethics',{beta:'ethics-investigator'})
];
function isolated(root,seats){
  return {root:join(root,'spaces'),workspaces:[{id:'alpha',label:'Fictional Alpha'},{id:'beta',label:'Fictional Beta'}],
    accounts:seats.map(({id,memberships,code})=>({id,memberships,codeHash:codeHash(code)}))};
}
async function start(options){
  const server=createServer(options).listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,
    stop:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(e=>e?reject(e):resolve());})};
}
function transport(live){
  return async function request(path,status,{workspace,token,body,origin}={}){
    const url=live.url+path+(workspace?'?workspace='+workspace:'');
    const response=await fetch(url,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin??live.url}),
        ...(token?{Cookie:token}:{})}});
    const data=await response.json();
    assert.equal(response.status,status,JSON.stringify(data));
    return {data,response,token:response.headers.get('set-cookie')?.split(';')[0]};
  };
}
test('isolated synthetic ethics: confidential phases, independent review, redaction and durability',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mvw-ethics-test-')), seats=accounts();
  const options={sqliteFile:join(root,'workspace.sqlite'),isolated:isolated(root,seats)};
  let live=await start(options);
  t.after(async()=>{await live.stop();await rm(root,{recursive:true,force:true});});
  const path='/api/ethics/cases';
  let request=transport(live);
  const login=async (index,workspace='alpha')=>
    (await request('/api/session/login',200,{body:{account:seats[index].id,code:seats[index].code,workspace}})).token;
  let author=await login(0), reviewer=await login(1);
  const ordinary=await login(2), beta=await login(3,'beta');
  await request(path,401,{workspace:'alpha'});
  await request(path,403,{workspace:'alpha',token:ordinary});
  await request(path,403,{workspace:'beta',token:author});
  await request('/api/projects',403,{workspace:'alpha',token:author,body:{}});
  const set=(suffix,status,body,token=author,workspace='alpha')=>request(path+suffix,status,{token,body,workspace});
  await set('',403,{category:'gifts',urgency:'priority'},reviewer);
  await set('',422,{category:'gift',urgency:'priority',note:'Synthetic rejected text field'});
  await set('',422,{category:'not_an_enum',urgency:'priority'});
  await request(path,403,{token:author,workspace:'alpha',body:{category:'gift',urgency:'priority'},origin:'https://example.invalid'});
  const created=(await set('',200,{category:'gift',urgency:'priority'})).data.case;
  assert.equal(created.status,'intake');
  assert.equal(created.revision,1);
  assert.equal(Object.hasOwn(created,'owner'),false);
  const id='/'+created.id;
  assert.deepEqual((await set('',200,undefined,reviewer)).data.cases,[]);
  assert.deepEqual((await set('',200,undefined,beta,'beta')).data.cases,[]);
  await set(id+'/triage',404,{route:'expedited',expectedRevision:1},beta,'beta');
  await set(id+'/export',404,undefined,reviewer);
  await set(id+'/triage',422,{route:'standard',expectedRevision:1});
  await set(id+'/begin',409,{expectedRevision:1});
  let revised=(await set(id+'/triage',200,{route:'expedited',expectedRevision:1})).data.case;
  assert.equal(revised.status,'triaged');
  await set(id+'/begin',409,{expectedRevision:1});
  revised=(await set(id+'/begin',200,{expectedRevision:2})).data.case;
  assert.equal(revised.status,'investigating');
  await set(id+'/submit',422,{expectedRevision:3,disposition:'no_action',findingVersion:1});
  await set(id+'/finding',422,{expectedRevision:3,outcome:'supported',evidence:'no_fixture'});
  revised=(await set(id+'/finding',200,{expectedRevision:3,outcome:'inconclusive',evidence:'no_fixture'})).data.case;
  await set(id+'/submit',422,{expectedRevision:4,disposition:'remediation',findingVersion:1});
  await set(id+'/submit',200,{expectedRevision:4,disposition:'unresolved',findingVersion:1});
  assert.equal((await set('',200,undefined,reviewer)).data.cases[0].status,'review');
  await set(id+'/export',409,undefined,reviewer);
  await set(id+'/close',403,{expectedRevision:5});
  await set(id+'/return',200,{expectedRevision:5,reason:'evidence'},reviewer);
  assert.deepEqual((await set('',200,undefined,reviewer)).data.cases,[]);
  await set(id+'/submit',422,{expectedRevision:6,disposition:'unresolved',findingVersion:1});
  await set(id+'/finding',200,{expectedRevision:6,outcome:'not_supported',evidence:'fixture_compare'});
  await set(id+'/submit',422,{expectedRevision:7,disposition:'no_action',findingVersion:1});
  await set(id+'/submit',200,{expectedRevision:7,disposition:'no_action',findingVersion:2});
  await set(id+'/close',409,{expectedRevision:7},reviewer);
  const closed=(await set(id+'/close',200,{expectedRevision:8},reviewer)).data.case;
  assert.equal(closed.revision,9);
  assert.equal(closed.review.findingVersion,2);
  assert.deepEqual(closed.findings.map(x=>x.version),[1,2]);
  await set(id+'/finding',409,{expectedRevision:9,outcome:'inconclusive',evidence:'no_fixture'});
  await set(id+'/export',403);
  const exported=await set(id+'/export',200,undefined,reviewer);
  assert.match(exported.response.headers.get('content-disposition'),/attachment/);
  assert.equal(exported.data.caseReference,'ETH-0001');
  assert.equal(exported.data.findingOutcome,'not_supported');
  assert.deepEqual(exported.data.activity.map(x=>x.action),['opened','triage','begin','finding','submit','return','finding','submit','close']);
  assert.doesNotMatch(JSON.stringify(exported.data),new RegExp(created.id+'|sample-|fixture_compare|proposal|returns|owner'));
  const download=await request('/api/audit/export',200,{workspace:'alpha',token:ordinary});
  assert.doesNotMatch(JSON.stringify(download.data),/ETH-0001|ethics-investigator|priority/);
  const state=await request('/api/state',200,{workspace:'alpha',token:ordinary});
  assert.equal(Object.hasOwn(state.data,'ethicsCases'),false);
  await live.stop();live=await start(options);request=transport(live);
  reviewer=await login(1);
  assert.deepEqual((await set(id+'/export',200,undefined,reviewer)).data,exported.data);
  const persisted=await readFile(options.sqliteFile);
  assert.equal(persisted.includes(Buffer.from('Synthetic rejected text field')),false);
});
test('ethics is not available as a demo or public intake',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mvw-ethics-demo-'));
  const live=await start({dataFile:join(root,'state.json')});
  t.after(async()=>{await live.stop();await rm(root,{recursive:true,force:true});});
  await transport(live)('/api/ethics/cases',404);
  await transport(live)('/api/ethics/cases',404,{body:{category:'gift',urgency:'routine'}});
});
test('browser: dedicated synthetic ethics screens open, return, close and download a redacted summary',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000,
},async t=>{
  const {chromium}=require('playwright');
  const root=await mkdtemp(join(tmpdir(),'mvw-ethics-browser-')),seats=accounts();
  const live=await start({dataFile:join(root,'state.json'),isolated:isolated(root,seats)});
  t.after(async()=>{await live.stop();await rm(root,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const a=await browser.newPage({viewport:{width:390,height:844}});
    const reviewerContext=await browser.newContext({acceptDownloads:true});
    const r=await reviewerContext.newPage();
    const stale=await r.context().newPage();
    const errors=[];
    for(const page of [a,r,stale]){page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));}
    async function login(page,seat){
      await page.goto(live.url);
      await page.getByLabel('Test account').fill(seat.id);
      await page.getByLabel('Workspace ID').fill('alpha');
      await page.getByLabel('Local access code').fill(seat.code);
      const [signedIn]=await Promise.all([
        page.waitForResponse(response=>new URL(response.url()).pathname==='/api/session/login'),
        page.getByRole('button',{name:'Sign in'}).click()
      ]);
      assert.equal(signedIn.status(),200);
      await page.getByRole('heading',{name:'Synthetic ethics case management'}).waitFor();
    }
    await login(a,seats[0]);await login(r,seats[1]);
    assert.equal(await r.getByLabel('Fictional report category').count(),0);
    assert.equal(await r.getByRole('button',{name:'Assessments'}).isVisible(),false);
    await a.getByLabel('Fictional report category').selectOption('records');
    await a.getByLabel('Fictional intake priority').selectOption('priority');
    await a.getByRole('button',{name:'Open synthetic case'}).click();
    const aCase=a.locator('#ethics-view article'),rCase=r.locator('#ethics-view article');
    await aCase.getByRole('heading',{name:'ETH-0001 · Records handling'}).waitFor();
    assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth),390);
    await a.getByLabel('Review path').selectOption('expedited');
    await a.getByRole('button',{name:'Save triage'}).click();
    await a.getByRole('button',{name:'Begin investigation'}).click();
    async function find(outcome,evidenceName){
      await a.getByLabel('Finding outcome').selectOption(outcome);
      await a.getByLabel('Synthetic evidence basis').selectOption(evidenceName);
      await a.getByRole('button',{name:'Record finding version'}).click();
    }
    async function submit(choice){
      await a.getByLabel('Proposed disposition').selectOption(choice);
      await a.getByRole('button',{name:'Submit for closure review'}).click();
      await aCase.getByText(/Closure review ·/).waitFor();
      await r.getByRole('button',{name:'Ethics cases'}).click();
    }
    await find('inconclusive','no_fixture');
    await submit('unresolved');
    await r.getByLabel('Return reason').selectOption('finding');
    await r.getByRole('button',{name:'Return for revision'}).click();
    await r.getByText('No case has been submitted for independent review.').waitFor();
    await a.getByRole('button',{name:'Browse workspace'}).click();
    await a.getByRole('button',{name:'Ethics cases'}).click();
    await aCase.getByText('Review returns',{exact:true}).click();
    await aCase.getByText('Version 1 · Clarify the finding outcome',{exact:true}).waitFor();
    await find('not_supported','fixture_compare');
    await submit('no_action');
    // A second tab in the reviewer's existing authenticated context must still revalidate its stale revision.
    await stale.goto(live.url);
    await stale.getByRole('button',{name:'Approve synthetic closure'}).waitFor();
    await r.getByRole('button',{name:'Approve synthetic closure'}).click();
    await rCase.getByText(/Approved disposition:/).waitFor();
    await stale.getByRole('button',{name:'Approve synthetic closure'}).click();
    await stale.getByRole('button',{name:'Reload ethics cases'}).click();
    await stale.getByText(/Approved disposition:/).waitFor();
    await rCase.getByText('Finding versions',{exact:true}).click();
    assert.equal(await rCase.getByText(/^Version .*scenario/).count(),2);
    await rCase.getByText('Case activity',{exact:true}).click();
    await rCase.getByText(/close · ethics-reviewer · Revision 9/).waitFor();
    const [download]=await Promise.all([r.waitForEvent('download'),rCase.getByRole('link',{name:'Download redacted summary'}).click()]);
    const digest=JSON.parse(await readFile(await download.path(),'utf8'));
    assert.equal(digest.findingVersion,2);
    assert.equal(digest.mode,'synthetic-ethics-redacted');
    assert.equal(await r.getByRole('button',{name:'Approve synthetic closure'}).count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
