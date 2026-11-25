'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {once}=require('node:events');
const {createHash,randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server');
const {openSqlite}=require('../durable-storage');
const {codeHash}=require('../workspace-access');
const {inspect,change}=require('../rights-retrieval');

const cases='/api/rights/cases',portal='/api/requester';
const source='fictional-preference-ledger-v1';
const notes=/FIXTURE-DENIED|internalRecordId|privateMemo|internalDebug|STAFF-ONLY|resultBinding|authoredBy|reviewedBy|privatePayload/;
const makeCode=()=>randomBytes(32).toString('base64url');
const due=model=>({expectedCaseRevision:model.caseRevision,expectedRevision:model.revision});
const exact=model=>({...due(model),digest:model.digest});
const resultKey=model=>({expectedRevision:model.version,digest:model.digest});
async function instance(t,enabled=true){
  const root=await mkdtemp(join(tmpdir(),'trust-rights-retrieval-'));
  const file=join(root,'synthetic.sqlite');
  const definitions={
    author:{id:'fictional-author',memberships:{alpha:'analyst'}},
    reviewer:{id:'fictional-reviewer',memberships:{alpha:'reviewer'}},
    operator:{id:'fictional-operator',memberships:{alpha:'case-operator'}},
    other:{id:'fictional-other',memberships:{beta:'analyst'}},
  };
  const codes=Object.fromEntries([...Object.keys(definitions),'request','peer','beta','correction'].map(name=>[name,makeCode()]));
  let now=Date.now(),live;
  const isolated={root:join(root,'rooms'),now:()=>now,workspaces:[{id:'alpha',label:'Fictional A'},{id:'beta',label:'Fictional B'}],
    accounts:Object.entries(definitions).map(([name,row])=>({...row,codeHash:codeHash(codes[name])})),
    requesterReleaseWorkspaces:enabled?['alpha','beta']:[],
    requesterGrants:['request','peer','beta','correction'].map(name=>({id:'fictional-'+name,alias:'sample-'+name,
      workspace:name==='beta'?'beta':'alpha',codeHash:codeHash(codes[name]),expiresAt:now+(name==='request'?120000:180000)})),
  };
  async function stop(){if(live)await new Promise(resolve=>{live.server.closeAllConnections();live.server.close(resolve);});}
  async function start(){
    const server=createServer({sqliteFile:file,isolated}).listen(0,'127.0.0.1');
    await once(server,'listening');live={server,url:'http://127.0.0.1:'+server.address().port};
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  const req=async(path,status,{body,cookie,workspace,origin}={})=>{
    const target=live.url+path+(workspace?'?workspace='+workspace:'');
    const response=await fetch(target,{signal:AbortSignal.timeout(6000),
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:origin??live.url,'Content-Type':'application/json'})},
    });
    const data=await response.json();
    assert.equal(response.status,status,path+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(name,workspace='alpha')=>(await req('/api/session/login',200,{body:{account:definitions[name].id,code:codes[name],workspace}})).cookie;
  const ask=(path,status,cookie,body,workspace='alpha')=>req(path,status,{cookie,body,workspace}).then(x=>x.data);
  const visitor=(action,name,status=200,body={})=>req(portal+'/'+action,status,{body:{code:codes[name]??name,...body}}).then(x=>x.data);
  async function process(kind,seat,a,r,{begin=true}={}){
    await visitor('intake',seat,200,{kind});
    const row=(await ask(cases,200,a)).cases.at(-1);
    const key=cases+'/'+row.id;
    await ask(key+'/verify',200,r,{expectedRevision:1,note:'Fictional STAFF-ONLY identity note'});
    if(begin)await ask(key+'/begin',200,a,{expectedRevision:2,note:'Fictional STAFF-ONLY fulfillment note'});
    return {id:row.id,key,retrieve:key+'/retrieval'};
  }
  return {file,req,ask,login,visitor,process,codes,get base(){return live.url;},advance:ms=>{now+=ms;},
    restart:async alter=>{await stop();alter?.(isolated);await start();}};
}
function projectionShape(output){
  assert.deepEqual(Object.keys(output).sort(),['categories','rowsReviewed','schemaVersion']);
  assert.equal(output.schemaVersion,1);
  assert.ok([3,4].includes(output.rowsReviewed));
  assert.deepEqual(output.categories.map(row=>Object.keys(row).sort()),[['category','count','label'],['category','count','label']]);
  assert.deepEqual(output.categories.map(row=>row.category),['preference','service']);
  assert.equal(output.categories.reduce((sum,row)=>sum+row.count,0),output.rowsReviewed);
}
test('scoped HTTP retrieval persists only typed redaction; exact rework and independent review never release it',async t=>{
  const f=await instance(t);
  const a=await f.login('author'),r=await f.login('reviewer'),operator=await f.login('operator'),other=await f.login('other','beta');
  const c=await f.process('access','request',a,r);
  await f.visitor('intake','peer',200,{kind:'access'});
  await f.visitor('intake','beta',200,{kind:'access'});
  await f.ask(c.retrieve,401);
  await f.ask(c.retrieve,403,operator);
  await f.ask(c.retrieve,403,a,undefined,'beta');
  await f.ask(c.retrieve,404,other,undefined,'beta');
  await f.ask(c.retrieve,404,r);
  const start=await f.ask(c.retrieve,200,a);
  assert.deepEqual(start.actions,['retrieve']);
  assert.equal(start.stage,'not-retrieved');
  await f.ask(c.retrieve+'/retrieve',403,r,{...due(start),source});
  await f.req(c.retrieve+'/retrieve',403,{cookie:a,workspace:'alpha',body:{...due(start),source},origin:'https://example.invalid'});
  await f.ask(c.retrieve+'/retrieve',422,a,{...due(start),source,sourceUrl:'https://example.invalid/records'});
  await f.ask(c.retrieve+'/retrieve',422,a,{...due(start),source,body:'unbounded fictional free text'});
  await f.ask(c.retrieve+'/retrieve',422,a,{...due(start),source:'https://example.invalid/records'});
  const first=await f.ask(c.retrieve+'/retrieve',200,a,{...due(start),source});
  projectionShape(first.projection);
  assert.equal(first.caseId,c.id);
  assert.equal(first.caseRevision,3);
  assert.equal(first.revision,1);
  assert.equal(first.stage,'draft');
  assert.doesNotMatch(JSON.stringify(first),notes);
  await f.ask(c.retrieve,404,r);
  await f.ask(c.retrieve+'/submit',200,a,exact(first));
  const review=await f.ask(c.retrieve,200,r);
  assert.deepEqual(review.projection,first.projection);
  assert.equal(review.digest,first.digest);
  assert.doesNotMatch(JSON.stringify(review),notes);
  await f.ask(c.retrieve+'/approve',403,a,exact(first));
  await f.ask(c.retrieve+'/return',200,r,exact(first));
  await f.ask(c.retrieve,404,r);
  const returned=await f.ask(c.retrieve,200,a);
  assert.deepEqual(returned.actions,['retrieve']);
  const second=await f.ask(c.retrieve+'/retrieve',200,a,{...due(returned),source});
  assert.equal(second.revision,2);
  assert.notEqual(second.digest,first.digest);
  assert.deepEqual(second.projection,first.projection);
  await f.ask(c.retrieve+'/submit',409,a,exact(first));
  await f.ask(c.retrieve+'/submit',200,a,exact(second));
  await f.ask(c.retrieve+'/approve',409,r,{...exact(second),digest:first.digest});
  const approved=await f.ask(c.retrieve+'/approve',200,r,exact(second));
  assert.equal(approved.stage,'approved');
  assert.deepEqual(approved.projection,second.projection);
  assert.equal((await f.visitor('status','request')).resultAvailable,undefined);
  assert.deepEqual(await f.visitor('result','request'),{mode:'synthetic-requester-result',status:'not-available'});
  await f.visitor('result','request',422,{caseId:c.id});
  assert.doesNotMatch(JSON.stringify(await f.ask('/api/state',200,a)),/rightsRetrievals|rowsReviewed|FIXTURE-DENIED/);
  assert.doesNotMatch(JSON.stringify(await f.ask(cases,200,a)),/rightsRetrievals|rowsReviewed|FIXTURE-DENIED/);
  const audit=(await f.ask('/api/audit/export',200,r)).audit.filter(row=>row.action.startsWith('rights-retrieval.'));
  assert.equal(audit.at(-1).account,'fictional-reviewer');
  assert.equal(audit.at(-1).details.revision,2);
  assert.doesNotMatch(JSON.stringify(audit),/FIXTURE-DENIED|rowsReviewed|resultBinding|digest|Fictional preference/);
  const db=openSqlite(f.file,{readOnly:true});
  try{
    const rows=db.scope('workspace:alpha').read('workbench').rightsRetrievals[c.id];
    assert.equal(rows.length,2);
    assert.deepEqual(rows.map(row=>row.status),['returned','approved']);
    assert.ok(rows.every(row=>row.workspace==='alpha'&&row.caseId===c.id&&row.caseRevision===3));
    assert.doesNotMatch(JSON.stringify(rows),/FIXTURE-DENIED|internalRecordId|privateMemo|internalDebug|STAFF-ONLY/);
    assert.deepEqual(rows[1].projection,approved.projection);
  }finally{db.close();}
  await f.restart();
  const a2=await f.login('author'),r2=await f.login('reviewer');
  assert.deepEqual(await f.ask(c.retrieve,200,r2),approved);

  // Even an approved internal artifact does not do anything to the existing
  // requester path. After fulfillment, that flow still needs its own draft,
  // approval and separately explicit release; its projection is unchanged.
  await f.ask(c.key+'/fulfill',200,a2,{expectedRevision:3,note:'Fictional STAFF-ONLY completion'});
  await f.ask(c.retrieve,404,a2);
  assert.deepEqual(await f.visitor('result','request'),{mode:'synthetic-requester-result',status:'not-available'});
  const result=c.key+'/result/';
  const staged=(await f.ask(result+'draft',200,a2,{expectedRevision:0,selection:'summary-only'})).cases.find(row=>row.id===c.id).resultDelivery;
  await f.ask(result+'submit',200,a2,resultKey(staged));
  await f.ask(result+'approve',200,r2,resultKey(staged));
  assert.equal((await f.visitor('result','request')).status,'not-available');
  await f.ask(result+'release',200,r2,{...resultKey(staged),confirm:true});
  const released=await f.visitor('result','request');
  assert.deepEqual(released.result.sections,[{label:'Fictional example records',count:3}]);
  assert.doesNotMatch(JSON.stringify(released),/rowsReviewed|category|schemaVersion|STAFF-ONLY|FIXTURE-DENIED/);
  for(const code of ['peer','beta'])assert.equal((await f.visitor('result',code)).status,'not-available');
  const unknown=await f.visitor('result',makeCode(),401);
  f.advance(121000);
  assert.deepEqual(await f.visitor('result','request',401),unknown);
});
test('case mutations refuse stale reviews and noneligible cases; only a re-retrieval at current revision can be reviewed',async t=>{
  const f=await instance(t);
  const a=await f.login('author'),r=await f.login('reviewer');
  const c=await f.process('access','request',a,r);
  const begin=await f.ask(c.retrieve,200,a);
  const draft=await f.ask(c.retrieve+'/retrieve',200,a,{...due(begin),source});
  await f.ask(c.retrieve+'/submit',200,a,exact(draft));
  await f.ask(c.key+'/assign',200,a,{owner:'case-operator',expectedRevision:3,note:'Fictional assignment'});
  await f.ask(c.retrieve+'/approve',404,r,exact(draft));
  await f.ask(c.key+'/assign',200,a,{owner:'analyst',expectedRevision:4,note:'Fictional assignment restore'});
  const held=await f.ask(c.retrieve,200,a);
  assert.equal(held.stage,'stale');
  assert.equal(held.caseRevision,5);
  assert.equal(held.projection,undefined);
  await f.ask(c.retrieve,404,r);
  assert.equal((await f.ask(c.retrieve+'/approve',409,r,{...exact(draft),expectedCaseRevision:5})).code,'STALE_RETRIEVAL');
  const fresh=await f.ask(c.retrieve+'/retrieve',200,a,{...due(held),source});
  assert.equal(fresh.revision,2);
  assert.notEqual(fresh.digest,draft.digest);
  await f.ask(c.retrieve+'/submit',200,a,exact(fresh));
  await f.ask(c.retrieve+'/approve',200,r,exact(fresh));
  const correction=await f.process('correction','correction',a,r);
  await f.ask(correction.retrieve,404,a);
  const unstarted=await f.process('access','peer',a,r,{begin:false});
  await f.ask(unstarted.retrieve,404,a);
  f.advance(121000);
  await f.ask(c.retrieve,404,a);
});
test('legacy portal status and defaults remain unchanged when the workspace is not provisioned',async t=>{
  const f=await instance(t,false);
  const a=await f.login('author'),r=await f.login('reviewer'),c=await f.process('access','request',a,r);
  await f.ask(c.retrieve,404,a);
  await f.restart(config=>{config.requesterReleaseWorkspaces=['alpha','beta'];});
  await f.ask(c.retrieve,404,await f.login('author')); // Cannot retroactively bind.
  const status=await f.visitor('status','request');
  assert.deepEqual(Object.keys(status).sort(),['mode','receipt','receivedDate','requestType','status']);
});
test('re-sealing refuses a private projection field even with a forged matching digest; same account cannot self-review',()=>{
  const binding='1'.repeat(64),row={id:'fictional-case',kind:'access',source:'synthetic-portal',status:'in-progress',owner:'analyst',
    identity:{status:'verified'},revision:3};
  const state={rightsCases:[row],requesterReceipts:[{caseId:row.id,grantId:'fake-grant',resultBinding:binding}]};
  const a={role:'analyst',account:'fictional-author',workspace:'alpha',activeReleaseBinding:()=>binding};
  const same={...a,role:'reviewer'},r={...same,account:'fictional-reviewer'};
  const event=()=>{};
  const draft=change(state,row.id,'retrieve',a,{...due(inspect(state,row.id,a)),source},event);
  change(state,row.id,'submit',a,exact(draft),event);
  assert.throws(()=>change(state,row.id,'approve',same,exact(draft),event),{code:'RETRIEVAL_ACTION'});
  assert.throws(()=>inspect(state,row.id,{...a,workspace:'beta'}),{code:'RETRIEVAL_NOT_FOUND'});
  const record=state.rightsRetrievals[row.id][0];
  record.projection.categories[0].privateMemo='FIXTURE-DENIED-INJECTED';
  record.digest=createHash('sha256').update(JSON.stringify(['synthetic-rights-retrieval',record.workspace,record.caseId,
    record.caseRevision,record.binding,record.revision,record.source,record.projection])).digest('hex');
  assert.throws(()=>inspect(state,row.id,r),{code:'RETRIEVAL_NOT_FOUND'});
  assert.throws(()=>change(state,row.id,'approve',r,{...exact(draft),digest:record.digest},event),{code:'STALE_RETRIEVAL'});
  assert.doesNotMatch(JSON.stringify(inspect(state,row.id,a)),notes);
});

test('Chromium staff retrieval: lazy disclosure, independent exact review, stale retry, internal only',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright and Chromium',timeout:45000,
},async t=>{
  const f=await instance(t);
  const author=await f.login('author'),reviewer=await f.login('reviewer');
  const ready=await f.process('access','request',author,reviewer);
  const pending=await f.process('access','peer',author,reviewer,{begin:false});
  const correction=await f.process('correction','correction',author,reviewer);
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const a=await browser.newPage(),r=await browser.newPage(),stalePage=await browser.newPage(),operator=await browser.newPage();
    const errors=[],requests=new Map();
    for(const page of [a,r,stalePage,operator]){
      page.setDefaultTimeout(7000);
      requests.set(page,[]);
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{
        const url=new URL(request.url());
        if(url.pathname.includes('/retrieval'))requests.get(page).push([request.method(),url.pathname,url.searchParams.get('workspace')]);
      });
    }
    const exactText=(scope,text)=>scope.getByText(text,{exact:true});
    const exactButton=(scope,name)=>scope.getByRole('button',{name,exact:true});
    const card=(page,id=ready.id)=>page.locator('#work-record-'+id);
    const disclosure=scope=>scope.locator('details').filter({hasText:/Internal fictional retrieval/});
    const summary=scope=>disclosure(scope).locator('summary');
    function operatorNames(page){
      return page===a?'author':page===operator?'operator':'reviewer';
    }
    async function signIn(page){
      const role=operatorNames(page);
      await page.goto(f.base);
      await page.getByLabel('Test account').fill('fictional-'+role);
      await page.getByLabel('Workspace ID').fill('alpha');
      await page.getByLabel('Local access code').fill(f.codes[role]);
      await exactButton(page,'Sign in').click();
      await exactButton(page,'Privacy rights').waitFor();
    }
    async function rights(page){
      await exactButton(page,'Privacy rights').click();
      await page.getByRole('heading',{name:'Privacy rights cases',exact:true}).waitFor();
    }
    async function focus(locator){
      await locator.waitFor({state:'visible'});
      assert.equal(await locator.evaluate(node=>document.activeElement===node),true);
    }
    async function act(page,label,action,status=200){
      const [wire]=await Promise.all([
        page.waitForResponse(response=>new URL(response.url()).pathname===ready.retrieve+'/'+action),
        exactButton(disclosure(card(page)),label).press('Enter'),
      ]);
      assert.equal(wire.status(),status);
      assert.equal(new URL(wire.url()).searchParams.get('workspace'),'alpha');
      return {body:wire.request().postDataJSON(),model:await wire.json()};
    }

    await signIn(a);
    assert.deepEqual(requests.get(a),[]);
    await rights(a);
    const ac=card(a);
    await summary(ac).waitFor();
    assert.equal(await summary(card(a,pending.id)).count(),0);
    assert.equal(await summary(card(a,correction.id)).count(),0);
    assert.deepEqual(requests.get(a),[]);
    const path='**'+ready.retrieve+'?workspace=alpha';
    const failOnce=route=>route.abort('failed');
    await a.route(path,failOnce,{times:1});
    await summary(ac).press('Enter');
    await exactText(disclosure(ac),'The retrieval could not be confirmed. Reload before retrying.').waitFor();
    await focus(summary(ac)); // An opening error does not steal focus.
    await exactButton(disclosure(ac),'Reload retrieval').press('Enter');
    await exactText(disclosure(ac),'Not retrieved').waitFor();
    await focus(summary(ac));
    assert.deepEqual(requests.get(a),[['GET',ready.retrieve,'alpha'],['GET',ready.retrieve,'alpha']]);
    const firstDraft=await act(a,'Retrieve fictional category counts','retrieve');
    assert.deepEqual(firstDraft.body,{source,expectedCaseRevision:3,expectedRevision:0});
    await exactText(disclosure(ac),'Redacted draft').waitFor();
    await focus(summary(ac));
    await disclosure(ac).getByRole('heading',{name:'Redacted category counts'}).waitFor();
    assert.doesNotMatch(await disclosure(ac).innerText(),notes);

    await signIn(r);
    await rights(r);
    assert.equal(await summary(card(r)).count(),0); // Analyst draft is not discoverable.
    const first=await act(a,'Submit exact retrieval for review','submit');
    assert.deepEqual(first.body,exact(firstDraft.model));
    await exactText(disclosure(ac),'Awaiting independent review').waitFor();
    await r.reload();
    await rights(r);
    const rc=card(r);
    await summary(rc).waitFor();
    assert.deepEqual(requests.get(r),[]);
    await signIn(stalePage);
    await rights(stalePage);
    const sc=card(stalePage);
    await summary(rc).press('Enter');
    await summary(sc).press('Enter');
    await exactText(disclosure(rc),'Awaiting independent review').waitFor();
    await exactText(disclosure(sc),'Awaiting independent review').waitFor();
    const returned=await act(r,'Return retrieval for rework','return');
    assert.deepEqual(returned.body,first.body);
    await exactText(disclosure(rc),'Returned for rework').waitFor();
    await focus(summary(rc));
    assert.equal(await disclosure(rc).getByRole('heading',{name:'Redacted category counts'}).count(),0);

    await summary(ac).press('Enter'); // Closing immediately discards the old projection.
    await disclosure(ac).getByRole('heading',{name:'Redacted category counts',includeHidden:true}).waitFor({state:'detached'});
    await summary(ac).press('Enter');
    await exactText(disclosure(ac),'Returned for rework').waitFor();
    const revised=await act(a,'Retrieve fictional category counts','retrieve');
    assert.equal(revised.model.revision,firstDraft.model.revision+1);
    assert.notEqual(revised.model.digest,firstDraft.model.digest);
    const second=await act(a,'Submit exact retrieval for review','submit');
    assert.deepEqual(second.body,exact(revised.model));
    const refused=await act(stalePage,'Approve this exact retrieval','approve',409);
    assert.deepEqual(refused.body,first.body);
    assert.equal(refused.model.code,'STALE_RETRIEVAL');
    const retry=exactButton(disclosure(sc),'Reload retrieval');
    await focus(retry);
    assert.equal(await disclosure(sc).getByRole('heading',{name:'Redacted category counts'}).count(),0);
    await retry.press('Enter');
    await exactText(disclosure(sc),'Retrieval revision 2 · Case revision 3').waitFor();
    await focus(summary(sc));
    const exactReview=await act(stalePage,'Approve this exact retrieval','approve');
    assert.deepEqual(exactReview.body,second.body);
    await exactText(disclosure(sc),'Approved for internal rehearsal only').waitFor();
    await focus(summary(sc));
    assert.equal(await exactButton(disclosure(sc),'Release approved result locally').count(),0);
    assert.doesNotMatch(await disclosure(sc).innerText(),notes);
    assert.deepEqual(await f.visitor('result','request'),{mode:'synthetic-requester-result',status:'not-available'});

    await f.ask(ready.key+'/assign',200,author,{owner:'case-operator',expectedRevision:3,note:'Fictional assignment for limited role'});
    await signIn(operator);
    await rights(operator);
    await card(operator).getByRole('heading',{name:'Access case'}).waitFor();
    assert.equal(await summary(card(operator)).count(),0);
    assert.deepEqual(requests.get(operator),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
