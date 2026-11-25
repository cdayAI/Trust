'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {spawn}=require('node:child_process');
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
    const reveal=async card=>{
      const disclosure=card.locator('[data-requester-result]');
      await disclosure.waitFor();
      if(!await disclosure.evaluate(node=>node.open))await disclosure.locator('summary').click();
    };
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

async function launchedRelease(t){
  const root=await mkdtemp(join(tmpdir(),'trust-release-result-acceptance-'));
  const launcher=spawn(process.execPath,[join(__dirname,'..','start-release.js')],{
    cwd:root,env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},stdio:['ignore','pipe','pipe'],
  });
  let errors='',output='',timer;
  launcher.stdout.setEncoding('utf8');launcher.stderr.setEncoding('utf8').on('data',chunk=>errors+=chunk);
  const closed=new Promise((resolve,reject)=>{launcher.once('error',reject);launcher.once('close',resolve);});
  closed.catch(()=>{});
  t.after(async()=>{
    if(launcher.exitCode===null&&launcher.signalCode===null)launcher.kill();
    try{await closed;}finally{await rm(root,{recursive:true,force:true,maxRetries:2});}
  });
  const ready=await Promise.race([
    new Promise(resolve=>launcher.stdout.on('data',chunk=>{
      output+=chunk;if(output.includes('\n'))resolve(JSON.parse(output.trim()));
    })),
    closed.then(()=>{throw new Error('Local release failed to start: '+errors);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Local release startup timed out.')),12000);}),
  ]).finally(()=>clearTimeout(timer));
  assert.equal(ready.status,'ready');
  assert.match(ready.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  const access=JSON.parse(await readFile(ready.accessFile,'utf8'));
  const seats={author:'sample-intake',reviewer:'sample-review'},workspace='harbor';
  const codes=Object.fromEntries(Object.entries(seats).map(([role,id])=>[role,access.staff.find(row=>row.id===id).code]));
  codes.request=access.requesters.find(row=>row.workspace===workspace).code;
  codes.otherWorkspace=access.requesters.find(row=>row.workspace==='orchard').code;
  async function request(path,status,{body,cookie,scoped=false}={}){
    const response=await fetch(ready.url+path+(scoped?'?workspace='+workspace:''),{
      signal:AbortSignal.timeout(6000),
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:ready.url,'Content-Type':'application/json'})},
    });
    const data=await response.json();
    assert.equal(response.status,status,path+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=role=>request('/api/session/login',200,{body:{account:seats[role],code:codes[role],workspace}});
  const staff=(path,status,session,body)=>request(path,status,{cookie:session.cookie,body,scoped:true}).then(x=>x.data);
  const visitor=(operation,key,status=200,body={})=>request(portal+'/'+operation,status,{body:{code:codes[key]??key,...body}}).then(x=>x.data);
  return {url:ready.url,seats,workspace,codes,login,staff,visitor};
}
async function requesterCheck(page,code){
  await page.getByLabel('Synthetic access code').fill(code);
  await page.getByRole('button',{name:'Check my request',exact:true}).click();
}
async function assertFocus(locator){
  await locator.waitFor();
  assert.equal(await locator.evaluate(node=>node===document.activeElement),true);
}
test('Chromium composed release: return, digest rework, stale retry, explicit release and requester focus/privacy', {
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1',timeout:45000,
},async t=>{
  const release=await launchedRelease(t),expiring=await fixture(t);
  const {id}=await fulfill(release);
  const exp=await fulfill(expiring);
  const draft=record(await expiring.staff(exp.result+'draft',200,exp.a,{expectedRevision:0,selection:'summary-only'}),exp.id).resultDelivery;
  await expiring.staff(exp.result+'submit',200,exp.a,permit(draft));
  await expiring.staff(exp.result+'approve',200,exp.r,permit(draft));
  await expiring.staff(exp.result+'release',200,exp.r,{...permit(draft),confirm:true});
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const analyst=await browser.newPage(),review=await browser.newPage(),stale=await browser.newPage(),
      visitor=await browser.newPage({viewport:{width:390,height:844}}),expired=await browser.newPage();
    const errors=[];
    for(const page of [analyst,review,stale,visitor,expired]){
      page.setDefaultTimeout(6500);page.on('pageerror',e=>errors.push(e.message));
    }
    async function caseCard(page,role){
      await page.goto(release.url);
      await page.getByLabel('Test account').fill(release.seats[role]);
      await page.getByLabel('Workspace ID').fill(release.workspace);
      await page.getByLabel('Local access code').fill(release.codes[role]);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByRole('button',{name:'Privacy rights',exact:true}).click();
      const card=page.locator('#work-record-'+id);
      await card.getByRole('heading',{name:'Access case'}).waitFor();
      return card;
    }
    const panel=card=>card.locator('details').filter({hasText:/Fictional requester result/});
    const summary=card=>panel(card).locator('summary');
    const button=(card,name)=>card.getByRole('button',{name,exact:true});
    const stage=(card,text)=>card.getByText('Stage: '+text,{exact:true}).waitFor({state:'attached'});
    async function actorAction(page,card,name,operation,status=200){
      const [wire]=await Promise.all([
        page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/result/'+operation)),
        button(card,name).press('Enter'),
      ]);
      assert.equal(wire.status(),status);
      return wire.request().postDataJSON();
    }
    await visitor.goto(release.url+'/requester');
    await requesterCheck(visitor,release.codes.request);
    const noResult=async()=>{
      await visitor.getByRole('heading',{name:'Simulation complete'}).waitFor();
      assert.equal(await visitor.getByRole('button',{name:'View approved fictional result'}).count(),0);
      assert.doesNotMatch(await visitor.locator('#portal-result').innerText(),/Fictional (?:preference|example records|access result)|INTERNAL|RAW-RESULT/);
    };
    const refreshWithoutResult=async()=>{
      const [response]=await Promise.all([
        visitor.waitForResponse(item=>new URL(item.url()).pathname==='/api/requester/status'),
        button(visitor,'Refresh status').click(),
      ]);
      assert.equal(response.status(),200);
      assert.equal((await response.json()).resultAvailable,undefined);
      await noResult();
    };
    await noResult();

    const a=await caseCard(analyst,'author');
    await summary(a).press('Enter');
    await a.getByLabel('Fictional result projection').selectOption('category-overview');
    await actorAction(analyst,a,'Save redacted result draft','draft');
    await stage(a,'draft');
    await assertFocus(summary(a));
    const first=await actorAction(analyst,a,'Submit exact result for review','submit');
    await stage(a,'review');
    const r=await caseCard(review,'reviewer'),s=await caseCard(stale,'reviewer');
    await summary(r).press('Enter');await summary(s).press('Enter');
    await r.getByText('Fictional preference examples: 2').waitFor();
    const sentBack=await actorAction(review,r,'Return result for changes','return');
    assert.deepEqual(sentBack,first);
    await panel(r).waitFor({state:'detached'});
    await assertFocus(r.getByRole('heading',{name:'Access case'}));
    await refreshWithoutResult();

    await analyst.getByRole('button',{name:'Work queue',exact:true}).click();
    await analyst.getByRole('button',{name:'Privacy rights',exact:true}).click();
    await summary(a).press('Enter');
    await stage(a,'returned');
    await a.getByLabel('Fictional result projection').selectOption('summary-only');
    await actorAction(analyst,a,'Save redacted result draft','draft');
    await stage(a,'draft');
    assert.doesNotMatch(await panel(a).innerText(),/Fictional preference examples/);
    const second=await actorAction(analyst,a,'Submit exact result for review','submit');
    await stage(a,'review');
    assert.equal(second.expectedRevision,first.expectedRevision+1);
    assert.notEqual(second.digest,first.digest);
    assert.deepEqual(await actorAction(stale,s,'Approve this exact result','approve',409),first);
    const reload=stale.getByRole('button',{name:'Reload cases',exact:true});
    await assertFocus(reload);
    await reload.press('Enter');
    await s.getByText('Fictional example records: 3').waitFor();
    await assertFocus(summary(s));
    assert.equal(await s.getByText('Fictional preference examples: 2').count(),0);
    assert.deepEqual(await actorAction(stale,s,'Approve this exact result','approve'),second);
    await stage(s,'approved');
    await refreshWithoutResult();
    await s.getByLabel('Confirm release to the original synthetic code.').check();
    assert.deepEqual(await actorAction(stale,s,'Release approved result locally','release'),{...second,confirm:true});
    await stage(s,'released');
    await assertFocus(summary(s));

    await button(visitor,'Refresh status').click();
    await button(visitor,'View approved fictional result').press('Enter');
    const resultHeading=visitor.getByRole('heading',{name:'Fictional access result',exact:true});
    await assertFocus(resultHeading);
    assert.match(await visitor.locator('#portal-result').innerText(),/Fictional example records: 3/);
    assert.doesNotMatch(await visitor.locator('#portal-result').innerText(),/Fictional preference|INTERNAL|RAW-RESULT/);
    let releaseRefresh;
    const refreshGate=new Promise(resolve=>{releaseRefresh=resolve;});
    const delayStatus=async route=>{await refreshGate;await route.continue();};
    await visitor.route('**/api/requester/status',delayStatus);
    try{
      const requested=visitor.waitForRequest(request=>new URL(request.url()).pathname==='/api/requester/status');
      await button(visitor,'Refresh status').click();
      await requested;
      assert.equal(await resultHeading.count(),0);
    }finally{releaseRefresh();}
    await button(visitor,'View approved fictional result').waitFor();
    await visitor.unroute('**/api/requester/status',delayStatus);
    await button(visitor,'View approved fictional result').press('Enter');
    await assertFocus(resultHeading);

    // Changing capability removes an already-disclosed projection.
    await requesterCheck(visitor,release.codes.otherWorkspace);
    await visitor.getByRole('heading',{name:'No request submitted'}).waitFor();
    assert.equal(await resultHeading.count(),0);
    assert.equal(await button(visitor,'View approved fictional result').count(),0);
    assert.doesNotMatch(await visitor.locator('#portal-result').innerText(),/Receipt:|Fictional example records/);

    // Start a real result request, then change to a different workspace's
    // grant before the original wire response is allowed to return.
    await requesterCheck(visitor,release.codes.request);
    const view=button(visitor,'View approved fictional result');
    await view.waitFor();
    let releaseResult;
    const resultGate=new Promise(resolve=>{releaseResult=resolve;});
    const delayResult=async route=>{await resultGate;await route.continue();};
    await visitor.route('**/api/requester/result',delayResult);
    const requested=visitor.waitForRequest(request=>new URL(request.url()).pathname==='/api/requester/result');
    const finished=visitor.waitForEvent('requestfinished',{predicate:request=>new URL(request.url()).pathname==='/api/requester/result'});
    try{
      await view.press('Enter');
      await requested;
      await requesterCheck(visitor,release.codes.otherWorkspace);
      await visitor.getByRole('heading',{name:'No request submitted'}).waitFor();
    }finally{releaseResult();}
    await finished;
    await visitor.unroute('**/api/requester/result',delayResult);
    await visitor.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await resultHeading.count(),0);
    assert.doesNotMatch(await visitor.locator('#portal-result').innerText(),/Receipt:|Fictional example records/);
    await requesterCheck(visitor,makeCode());
    const generic='A valid local synthetic access code is required.';
    await visitor.getByText(generic,{exact:true}).waitFor();
    await assertFocus(visitor.getByLabel('Synthetic access code'));
    assert.equal(await button(visitor,'Clear access code').count(),0);

    await expired.goto(expiring.url+'/requester');
    await requesterCheck(expired,expiring.codes.request);
    await button(expired,'View approved fictional result').press('Enter');
    await assertFocus(expired.getByRole('heading',{name:'Fictional access result',exact:true}));
    expiring.advance(61000);
    await button(expired,'Refresh status').click();
    await expired.getByText(generic,{exact:true}).waitFor();
    await assertFocus(expired.getByLabel('Synthetic access code'));
    assert.equal(await expired.getByRole('heading',{name:'Fictional access result'}).count(),0);
    assert.equal(await expired.locator('#portal-result').innerText(),await visitor.locator('#portal-result').innerText());
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
