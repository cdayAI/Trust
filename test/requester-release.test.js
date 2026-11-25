'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const {change}=require('../requester-release');

const cases='/api/rights/cases';
const portal='/api/requester';
const makeCode=()=>randomBytes(32).toString('base64url');
async function fixture(t,enabled=true){
  const room=await mkdtemp(join(tmpdir(),'trust-request-release-'));
  const codes=Object.fromEntries(['author','reviewer','limited','otherStaff','request','peer','beta','denied','correction'].map(name=>[name,makeCode()]));
  const seats=[
    {id:'sample-author',memberships:{alpha:'analyst'}},
    {id:'sample-reviewer',memberships:{alpha:'reviewer'}},
    {id:'sample-limited',memberships:{alpha:'case-operator'}},
    {id:'sample-otherstaff',memberships:{beta:'analyst'}},
  ];
  const ids=['author','reviewer','limited','otherStaff'];
  let now=Date.now(),live;
  const isolated={root:join(room,'private'),now:()=>now,
    workspaces:[{id:'alpha',label:'Fictional A'},{id:'beta',label:'Fictional B'}],
    accounts:seats.map((seat,i)=>({...seat,codeHash:codeHash(codes[ids[i]])})),
    requesterGrants:['request','peer','beta','denied','correction'].map(id=>({id:'fictional-'+id,alias:'sample-'+id,
      workspace:id==='beta'?'beta':'alpha',codeHash:codeHash(codes[id]),expiresAt:now+(id==='request'?60000:300000)})),
    requesterReleaseWorkspaces:enabled?['alpha','beta']:[],
  };
  async function close(){if(live)await new Promise(resolve=>{live.server.closeAllConnections();live.server.close(resolve);});}
  async function start(){
    const server=createServer({sqliteFile:join(room,'store.sqlite'),isolated}).listen(0,'127.0.0.1');
    await once(server,'listening');live={server,url:'http://127.0.0.1:'+server.address().port};
  }
  t.after(async()=>{await close();await rm(room,{recursive:true,force:true});});
  await start();
  async function request(path,status,{body,cookie,workspace,origin}={}){
    const response=await fetch(live.url+path+(workspace?'?workspace='+workspace:''),{
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:origin??live.url,'Content-Type':'application/json'})}
    });
    const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(name,workspace='alpha')=>{
    const index=ids.indexOf(name);
    return request('/api/session/login',200,{body:{code:codes[name],account:seats[index].id,workspace}});
  };
  const staff=(path,status,session,body,workspace='alpha')=>request(path,status,{cookie:session.cookie,body,workspace}).then(x=>x.data);
  const visitor=(action,key,status=200,body={})=>request(portal+'/'+action,status,{body:{code:codes[key]??key,...body}}).then(x=>x.data);
  return {codes,seats,ids,isolated,request,login,staff,visitor,get url(){return live.url;},advance:ms=>{now+=ms;},
    restart:async update=>{await close();update?.(isolated);await start();}};
}
async function fulfill(f,key='request',kind='access'){
  const portalIntake=await f.visitor('intake',key,200,{kind});
  const a=await f.login('author'),r=await f.login('reviewer');
  const created=(await f.staff(cases,200,a)).cases.at(-1);
  const path=cases+'/'+created.id;
  await f.staff(path+'/verify',200,r,{expectedRevision:1,note:'Fictional INTERNAL-VERIFY trace'});
  await f.staff(path+'/begin',200,a,{expectedRevision:2,note:'Fictional INTERNAL-BEGIN trace'});
  await f.staff(path+'/fulfill',200,a,{expectedRevision:3,note:'Fictional RAW-RESULT should never echo'});
  return {portalIntake,a,r,path,id:created.id,result:path+'/result/'};
}
const notAvailable={mode:'synthetic-requester-result',status:'not-available'};
const permit=(m)=>({expectedRevision:m.version,digest:m.digest});
function record(model,id){return model.cases.find(row=>row.id===id);}
test('release authority also rejects the same account after a hypothetical author to reviewer role change',()=>{
  const row={id:'test-case',source:'synthetic-portal',kind:'access',status:'fulfilled',closedAt:'2020-01-01',
    identity:{status:'verified'},completion:{method:'simulation-only',releasedData:false},revision:4};
  const binding='1'.repeat(64),state={rightsCases:[row],requesterReceipts:[{caseId:row.id,grantId:'fixture',resultBinding:binding}]};
  const ctx={role:'analyst',account:'same-account',activeReleaseBinding:()=>binding},event=()=>{};
  change(state,row.id,'draft',ctx,{expectedRevision:0,selection:'summary-only'},event);
  const {digest}=state.requesterReleases[row.id][0],body={expectedRevision:1,digest};
  change(state,row.id,'submit',ctx,body,event);
  assert.throws(()=>change(state,row.id,'approve',{...ctx,role:'reviewer'},body,event),{code:'RESULT_ACTION_UNAVAILABLE'});
});
test('SQLite HTTP approval and explicit release preserve private history and exact provisioned code binding',async t=>{
  const f=await fixture(t);
  const {a,r,path,result,id,portalIntake}=await fulfill(f);
  const o=await f.login('limited'),b=await f.login('otherStaff','beta');
  await f.visitor('intake','peer',200,{kind:'access'});
  await f.visitor('intake','beta',200,{kind:'access'});
  await f.request(portal+'/result?unused=1',422,{body:{code:f.codes.request}});
  await f.visitor('result','request',422,{caseId:id});
  await f.visitor('result','request',422,{receipt:portalIntake.receipt});
  assert.deepEqual(await f.visitor('result','request'),notAvailable);
  const before=record(await f.staff(cases,200,a),id);
  assert.equal(before.resultDelivery.stage,'not-prepared');
  assert.equal(record(await f.staff(cases,200,r),id).resultDelivery,undefined);
  for(const [who,pathName,expect] of [[r,'draft',403],[a,'approve',403],[o,'draft',403],[b,'draft',404]])
    await f.staff(result+pathName,expect,who,{expectedRevision:0,selection:'summary-only'},who===b?'beta':'alpha');
  await f.staff(result+'draft',422,a,{expectedRevision:0,selection:'summary-only',raw:'do not accept real text'});
  await f.staff(result+'draft',422,a,{expectedRevision:0,selection:'arbitrary-content'});
  await f.request(result+'draft',403,{workspace:'alpha',body:{expectedRevision:0,selection:'summary-only'},cookie:a.cookie,origin:'https://example.invalid'});
  let candidate=record(await f.staff(result+'draft',200,a,{expectedRevision:0,selection:'category-overview'}),id).resultDelivery;
  assert.deepEqual(candidate.preview.sections.map(x=>x.count),[2,1]);
  assert.equal(record(await f.staff(cases,200,r),id).resultDelivery,undefined);
  await f.staff(result+'submit',200,a,permit(candidate));
  await f.staff(result+'return',200,r,permit(candidate));
  await f.staff(result+'approve',409,r,permit(candidate));
  const old=candidate;
  candidate=record(await f.staff(result+'draft',200,a,{expectedRevision:1,selection:'summary-only'}),id).resultDelivery;
  await f.staff(result+'submit',200,a,permit(candidate));
  await f.staff(result+'approve',409,r,permit(old));
  await f.staff(result+'approve',409,r,{...permit(candidate),digest:old.digest});
  await f.staff(result+'approve',200,r,permit(candidate));
  assert.deepEqual(await f.visitor('result','request'),notAvailable);
  assert.equal((await f.visitor('status','request')).resultAvailable,undefined);
  await f.staff(result+'release',422,r,{...permit(candidate),confirm:false});
  await f.staff(result+'release',403,a,{...permit(candidate),confirm:true});
  await f.staff(result+'release',200,r,{...permit(candidate),confirm:true});
  await f.staff(result+'release',409,r,{...permit(candidate),confirm:true});
  await f.staff(result+'draft',409,a,{expectedRevision:2,selection:'category-overview'});
  const after=record(await f.staff(cases,200,a),id);
  const {resultDelivery:oldModel,...oldCase}=before,{resultDelivery:newModel,...newCase}=after;
  assert.deepEqual(newCase,oldCase);
  assert.equal(newCase.completion.releasedData,false);
  const resultBody={mode:'synthetic-requester-result',status:'available',
    result:{title:'Fictional access result',sections:[{label:'Fictional example records',count:3}]}};
  assert.deepEqual(await f.visitor('result','request'),resultBody);
  assert.deepEqual(await f.visitor('result','peer'),notAvailable);
  assert.deepEqual(await f.visitor('result','beta'),notAvailable);
  assert.deepEqual(await f.visitor('intake','request',200,{kind:'access'}),await f.visitor('status','request').then(({resultAvailable,...rest})=>rest));
  const raw=JSON.stringify(await f.visitor('result','request'));
  assert.doesNotMatch(raw,/INTERNAL|RAW-RESULT|fixture-source-marker|Fictional preference|caseId|digest|receipt|sample-reviewer/);
  const audit=await f.staff('/api/audit/export',200,r);
  const entries=audit.audit.filter(x=>x.action.startsWith('requester-release.'));
  assert.equal(entries.filter(x=>x.action==='requester-release.release').length,1);
  assert.equal(entries.at(-1).account,'sample-reviewer');
  assert.doesNotMatch(JSON.stringify(entries),/binding|digest|category-overview|summary-only|Fictional example records/);
  await f.restart();
  assert.deepEqual(await f.visitor('result','request'),resultBody);
  const expiredResponse=await f.visitor('result',makeCode(),401);
  f.advance(61000);
  assert.deepEqual(await f.visitor('result','request',401),expiredResponse);
  const replacement=makeCode();
  await f.restart(config=>{const grant=config.requesterGrants[0];grant.codeHash=codeHash(replacement);grant.expiresAt+=120000;});
  assert.deepEqual(await f.visitor('result',replacement),notAvailable);
  assert.equal((await f.visitor('status',replacement)).resultAvailable,undefined);
  assert.deepEqual(await f.visitor('result','request',401),expiredResponse);
  await f.staff(result+'draft',404,await f.login('author'),{expectedRevision:2,selection:'summary-only'});
});
test('old, manually opened, unverified and other-kind cases cannot release even after enabling the feature',async t=>{
  const f=await fixture(t,false);
  const old=await fulfill(f);
  assert.equal(record(await f.staff(cases,200,old.a),old.id).resultDelivery,undefined);
  await f.visitor('result','request',404);
  await f.restart(config=>{config.requesterReleaseWorkspaces=['alpha','beta'];});
  const a=await f.login('author'),r=await f.login('reviewer');
  await f.staff(old.result+'draft',404,a,{expectedRevision:0,selection:'summary-only'});
  const wrong=await fulfill(f,'correction','correction');
  await f.staff(wrong.result+'draft',404,a,{expectedRevision:0,selection:'summary-only'});
  await f.visitor('intake','denied',200,{kind:'access'});
  const denied=(await f.staff(cases,200,a)).cases.at(-1),deniedPath=cases+'/'+denied.id;
  await f.staff(deniedPath+'/result/draft',404,a,{expectedRevision:0,selection:'summary-only'});
  await f.staff(deniedPath+'/deny-verification',200,r,{expectedRevision:1,note:'Fictional rejected identity'});
  await f.staff(deniedPath+'/close-unverified',200,a,{expectedRevision:2,note:'Fictional close'});
  await f.staff(deniedPath+'/result/draft',404,a,{expectedRevision:0,selection:'summary-only'});
  const manual=(await f.staff(cases,200,a,{kind:'access',owner:'analyst',days:3,note:'Manual fictional access'})).cases.at(-1);
  const route=cases+'/'+manual.id;
  await f.staff(route+'/verify',200,r,{expectedRevision:1,note:'Simulated identity'});
  await f.staff(route+'/begin',200,a,{expectedRevision:2,note:'Simulated investigation'});
  await f.staff(route+'/fulfill',200,a,{expectedRevision:3,note:'Simulated closed'});
  await f.staff(route+'/result/draft',404,a,{expectedRevision:0,selection:'summary-only'});
});
test('Chromium: reviewer approval alone stays private, explicit release reveals only fixed fictional projection', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1',timeout:30000,
},async t=>{
  const f=await fixture(t);
  const {id}=await fulfill(f);
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const a=await browser.newPage(),r=await browser.newPage(),p=await browser.newPage({viewport:{width:390,height:844}});
    const errors=[];
    for(const page of [a,r,p]){page.setDefaultTimeout(6500);page.on('pageerror',e=>errors.push(e.message));}
    const rights=async(page,role)=>{
      const seat=f.seats[f.ids.indexOf(role)];
      await page.goto(f.url);
      await page.getByLabel('Test account').fill(seat.id);
      await page.getByLabel('Workspace ID').fill('alpha');
      await page.getByLabel('Local access code').fill(f.codes[role]);
      await page.getByRole('button',{name:'Sign in'}).click();
      await page.getByRole('button',{name:'Privacy rights',exact:true}).click();
      return page.locator('#work-record-'+id);
    };
    const reveal=async card=>card.getByText('Fictional requester result',{exact:true}).click();
    const author=await rights(a,'author');
    await reveal(author);
    await author.getByLabel('Fictional result projection').selectOption('summary-only');
    await author.getByRole('button',{name:'Save redacted result draft'}).click();
    await author.getByText('Stage: draft',{exact:true}).waitFor({state:'attached'});
    await reveal(author);
    await author.getByRole('button',{name:'Submit exact result for review'}).click();
    await author.getByText('Stage: review',{exact:true}).waitFor({state:'attached'});
    const decision=await rights(r,'reviewer');
    await reveal(decision);
    await decision.getByText('Fictional example records: 3').waitFor();
    await decision.getByRole('button',{name:'Approve this exact result'}).click();
    await decision.getByText('Stage: approved',{exact:true}).waitFor({state:'attached'});

    await p.goto(f.url+'/requester');
    await p.getByLabel('Synthetic access code').fill(f.codes.request);
    await p.getByRole('button',{name:'Check my request'}).click();
    await p.getByRole('heading',{name:'Simulation complete'}).waitFor();
    assert.equal(await p.getByRole('button',{name:'View approved fictional result'}).count(),0);
    await reveal(decision);
    await decision.getByRole('button',{name:'Release approved result locally'}).click();
    assert.equal(await decision.getByLabel('Confirm release to the original synthetic code.').isChecked(),false);
    await decision.getByLabel('Confirm release to the original synthetic code.').check();
    await decision.getByRole('button',{name:'Release approved result locally'}).click();
    await decision.getByText('Stage: released',{exact:true}).waitFor({state:'attached'});
    await p.getByRole('button',{name:'Refresh status'}).click();
    await p.getByRole('button',{name:'View approved fictional result'}).click();
    await p.getByText('Fictional example records: 3').waitFor();
    assert.doesNotMatch(await p.locator('#portal-result').innerText(),/INTERNAL|RAW-RESULT|fixture-source-marker|Reviewer/);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),390);
    await p.getByRole('button',{name:'Clear access code'}).click();
    assert.equal(await p.getByText('Fictional example records: 3').count(),0);
    await p.getByLabel('Synthetic access code').fill(f.codes.peer);
    await p.getByRole('button',{name:'Check my request'}).click();
    await p.getByRole('heading',{name:'No request submitted'}).waitFor();
    assert.equal(await p.getByRole('button',{name:'View approved fictional result'}).count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
