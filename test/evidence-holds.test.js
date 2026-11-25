'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {randomBytes,createHash}=require('node:crypto');
const {createServer}=require('../server');
const {backupDatabase,restoreDatabase,openSqlite}=require('../durable-storage');
const {codeHash}=require('../workspace-access');
const holds=require('../evidence-holds');
const {verifyEvidenceSnapshot}=require('../governance-documents');
const base='/api/governance-documents', title='Fictional exact edition';
const sample=Buffer.from('Fictional preservation fixture.\r\n');
const draftBody={kind:'policy',title,content:'Original fictional text.',links:[]};
const accounts={alice:'analyst',bob:'reviewer',charlie:'case-operator'};

async function fixture(t,{sqlite=false,manual=true}={}){
  const dir=await mkdtemp(join(tmpdir(),'trust-evidence-holds-'));
  let file=sqlite?join(dir,'workbench.sqlite'):undefined;
  const codes=Object.fromEntries(Object.keys(accounts).map(id=>[id,randomBytes(32).toString('base64url')]));
  const config={root:join(dir,'workspaces'),workspaces:[{id:'alpha',label:'Fictional Alpha'},{id:'beta',label:'Fictional Beta'}],
    ...(manual?{attachmentReviewWorkspaces:['alpha']}:{}),
    accounts:Object.entries(accounts).map(([id,role])=>({id,codeHash:codeHash(codes[id]),memberships:{alpha:role,beta:role}}))};
  let origin,server;
  async function start(){
    server=createServer({sqliteFile:file,isolated:config}).listen(0,'127.0.0.1');
    await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){
    if(!server?.listening)return;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  await start();
  async function api(route,status,{cookie,body,workspace='alpha'}={}){
    const url=new URL(route,origin);
    if(workspace)url.searchParams.set('workspace',workspace);
    const res=await fetch(url,{method:body===undefined?'GET':'POST',headers:{
      ...(cookie?{cookie}:{}),...(body===undefined?{}:{origin,'content-type':'application/json'})
    },...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6000)});
    const value=res.headers.get('content-type')==='application/octet-stream'?Buffer.from(await res.arrayBuffer()):await res.json();
    assert.equal(res.status,status,JSON.stringify(value));return {value,res};
  }
  const login=async(account,workspace='alpha')=>(await api('/api/session/login',200,{body:{account,workspace,code:codes[account]},workspace:null}))
    .res.headers.get('set-cookie').split(';')[0];
  const swap=()=>{
    [config.accounts[0].memberships.alpha,config.accounts[1].memberships.alpha]=[
      config.accounts[1].memberships.alpha,config.accounts[0].memberships.alpha
    ];
  };
  return {dir,api,start,stop,login,codes,swap,get origin(){return origin;},get file(){return file;},updateFile:value=>{file=value;}};
}

async function workflow(f){
  let [author,reviewer,operator]=await Promise.all(['alice','bob','charlie'].map(x=>f.login(x))),revision=0;
  async function post(path,body,status=200,cookie=author,workspace='alpha'){
    const result=await f.api(base+path,status,{cookie,body:{expectedRevision:revision,...body},workspace});
    if(status===200&&Number.isSafeInteger(result.value.revision))revision=result.value.revision;
    return result.value;
  }
  const initial=(await post('/records',draftBody)).documents[0],first=initial.revisions[0];
  const path='/records/'+initial.id+'/revisions/'+first.id,hold=path+'/evidence-hold';
  const audit=async()=>(await f.api('/api/audit/export',200,{cookie:reviewer})).value.audit;
  const view=async(cookie=author)=>(await f.api(base,200,{cookie})).value;
  const reLogin=async()=>{[author,reviewer,operator]=await Promise.all(['alice','bob','charlie'].map(x=>f.login(x)));};
  return {post,view,path,hold,initial,first,reLogin,audit,get revision(){return revision;},get reviewer(){return reviewer;},get operator(){return operator;}};
}

for(const sqlite of [false,true])test('exact published evidence holds do not change content and require separate release '+(sqlite?'in SQLite':'in JSON'),async t=>{
  const f=await fixture(t,{sqlite}),w=await workflow(f);
  const {post,path,hold,initial,first,view}=w;
  const reason='audit-review', place={reason};
  assert.equal((await post(hold+'/place',place,409)).code,'EVIDENCE_HOLD_EDITION');
  assert.equal((await post(hold+'/place',place,403,w.reviewer)).code,'ACCESS_DENIED');
  assert.equal((await post(hold+'/place',place,403,w.operator)).code,'ACCESS_DENIED');
  const other=await f.login('alice','beta');
  await post(hold+'/place',place,403,other);
  await post(hold+'/place',{...place,expectedRevision:0},404,other,'beta');

  const uploaded=(await post(path+'/attachments',{filename:'Fictional-preserved.txt',mediaType:'text/plain',data:sample.toString('base64')}))
    .documents[0].revisions[0].attachments[0];
  assert.equal(uploaded.reviewStatus,'pending');
  await post(path+'/attachments/'+uploaded.id+'/review',{operation:'release',sha256:uploaded.sha256},200,w.reviewer);
  await post(path+'/submit',{});
  await post(path+'/publish',{note:'Fictional decision.'},200,w.reviewer);
  const beforePlacement=(await view()).documents[0].revisions[0];
  const active=(await post(hold+'/place',place)).documents[0].revisions[0];
  const hand=active.evidenceHold,holdId=hand.id;
  assert.equal(hand.status,'active');
  assert.deepEqual({...active,evidenceHold:undefined},{...beforePlacement,evidenceHold:undefined});
  assert.equal((await post(hold+'/place',place,409)).code,'EVIDENCE_HOLD_EXISTS');
  assert.equal((await post(hold+'/place',{reason:'not-an-approved-reason'},422)).code,'EVIDENCE_HOLD_FIELDS');
  const scoped=(await view(w.operator)).documents[0].revisions[0];
  assert.equal(scoped.evidenceHold,undefined);
  assert.equal((await view(w.operator)).evidenceHoldReasons,undefined);
  const details=await post(path+'/read',{},200,w.operator);
  assert.equal(details.version.evidenceHold,undefined);
  assert.equal(details.text,draftBody.content);
  assert.equal((await post(path+'/attachments/'+uploaded.id+'/remove',{},409)).code,'IMMUTABLE_REVISION');

  const successor=(await post('/records/'+initial.id+'/revise',{title:'Later fictional edition',content:'Separate edition.',links:[]}))
    .documents[0].revisions[1];
  assert.deepEqual(successor.attachments,[]);
  assert.equal(successor.evidenceHold,undefined);
  const next='/records/'+initial.id+'/revisions/'+successor.id;
  await post(next+'/submit',{});
  await post(next+'/publish',{note:'Fictional review.'},200,w.reviewer);
  assert.equal((await post(next+'/evidence-hold/request-release',{holdId,reason:'review-complete'},404)).code,'EVIDENCE_HOLD_NOT_FOUND');
  const asked={holdId,reason:'review-complete'},decide={holdId,reason:'hold-no-longer-needed'};
  const askedRevision=w.revision;
  const prepared=(await post(hold+'/request-release',asked)).documents[0].revisions[0];
  assert.equal(prepared.evidenceHold.status,'release-requested');
  assert.equal((await post(hold+'/approve-release',{...decide,expectedRevision:askedRevision},409,w.reviewer)).code,'STALE_REVISION');
  assert.equal((await post(hold+'/approve-release',decide,403)).code,'ACCESS_DENIED');

  await f.stop();
  if(sqlite){
    const backup=join(f.dir,'evidence.json'),restored=join(f.dir,'restored.sqlite');
    backupDatabase(f.file,backup);restoreDatabase(backup,restored);
    f.updateFile(restored);
    const check=openSqlite(restored,{readOnly:true});
    try{
      const snapshot=check.snapshot().documents[0].payload;
      const altered=structuredClone(snapshot);
      altered.governanceDocuments.evidenceHolds.rows[0].edition=successor.id;
      assert.throws(()=>verifyEvidenceSnapshot(altered),/retention holds/);
    }finally{check.close();}
  }
  f.swap();await f.start();
  const formerAuthor=await f.login('alice');
  assert.equal((await post(hold+'/approve-release',decide,403,formerAuthor)).code,'EVIDENCE_HOLD_INDEPENDENCE');
  await f.stop();f.swap();await f.start();await w.reLogin();
  const restored=(await view()).documents[0].revisions[0];
  assert.equal(restored.evidenceHold.status,'release-requested');
  assert.equal(restored.evidenceHold.id,holdId);
  const again=(await post(hold+'/return-release',{holdId,reason:'keep-preserving'},200,w.reviewer)).documents[0].revisions[0];
  assert.equal(again.evidenceHold.status,'active');
  await post(hold+'/request-release',asked);
  const released=(await post(hold+'/approve-release',decide,200,w.reviewer)).documents[0].revisions[0];
  assert.equal(released.evidenceHold.status,'released');
  assert.equal(released.id,first.id);
  assert.equal(released.status,'published');
  assert.equal(released.contentHash,first.contentHash);
  assert.deepEqual(released.attachments,active.attachments);
  assert.equal((await post(hold+'/approve-release',decide,409,w.reviewer)).code,'EVIDENCE_HOLD_ORDER');
  const result=await f.api(base+path+'/attachments/'+uploaded.id+'/download',200,{cookie:w.reviewer,body:{}});
  assert.deepEqual(result.value,sample);
  assert.equal(result.res.headers.get('content-disposition'),'attachment; filename="Fictional-preserved.txt"');
  const entries=(await w.audit()).filter(e=>e.action.startsWith('governance-documents.evidence-hold.'));
  assert.deepEqual(entries.map(e=>e.action.split('.').at(-1)),['place','request-release','return-release','request-release','approve-release']);
  assert.ok(entries.every(e=>e.entityId===initial.id&&e.details.versionId===first.id&&e.details.holdId===holdId));
  assert.equal(entries.at(-1).account,'bob');
  assert.doesNotMatch(JSON.stringify(entries),/Fictional-preserved|Original fictional text|Fictional preservation fixture/);
});

test('hold verification rejects duplicate live pins and inconsistent transitions without any delete operation',()=>{
  const book={documents:[{id:'00000000-0000-4000-8000-000000000001',revisions:[{
    id:'00000000-0000-4000-8000-000000000002',status:'published',contentHash:'a'.repeat(64),
    contentLength:10,links:[],attachments:[]
  }]}]};
  const doc=book.documents[0],edition=doc.revisions[0];
  holds.transition(book,doc,edition,'place','analyst','alice',{reason:'audit-review'},'2026-01-05T00:00:00.000Z');
  const row=book.evidenceHolds.rows[0];
  assert.throws(()=>holds.transition(book,doc,edition,'request-release','analyst','alice',
    {holdId:row.id,reason:'review-complete'},'2026-01-04T00:00:00.000Z'),{code:'EVIDENCE_HOLD_CLOCK'});
  const altered=structuredClone(book);
  altered.evidenceHolds.rows.push({...row,id:'00000000-0000-4000-8000-000000000003'});
  assert.throws(()=>holds.verify(altered),/retention holds/);
  assert.deepEqual(Object.keys(holds.actions),['place','request-release','approve-release','return-release']);
});

test('Chromium shows exact-edition hold, analyst request and independent release',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Chromium',timeout:35_000
},async t=>{
  const {chromium}=require('playwright'),f=await fixture(t,{manual:false});
  const w=await workflow(f);
  await w.post(w.path+'/submit',{});
  await w.post(w.path+'/publish',{note:'Fictional review.'},200,w.reviewer);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  await page.goto(f.origin);
  async function login(id){
    // Sign-out reloads this page. Wait for that signed-out form instead of
    // starting a second navigation that can abort the legitimate reload.
    const account=page.getByLabel('Test account',{exact:true});
    await account.waitFor({state:'visible'});
    await account.fill(id);
    await page.getByLabel('Workspace ID',{exact:true}).fill('alpha');
    await page.getByLabel('Local access code',{exact:true}).fill(f.codes[id]);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
  }
  async function act(label,reason){
    const panel=page.locator('details').filter({has:page.locator('summary').getByText(label,{exact:true})});
    await panel.locator('summary').click();
    await panel.getByLabel('Fictional hold reason for '+label,{exact:true}).selectOption(reason);
    await panel.getByRole('button',{name:label,exact:true}).click();
  }
  await login('alice');
  await act('Place evidence hold','audit-review');
  await page.getByText('Hold active',{exact:true}).waitFor();
  await act('Request hold release','review-complete');
  await page.getByText('Hold active · release awaiting independent review',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await login('bob');
  await act('Approve hold release','review-complete');
  await page.getByText('Last hold released · evidence retained',{exact:true}).waitFor();
  await page.getByRole('button',{name:'View fictional text',exact:true}).click();
  await page.getByText(draftBody.content,{exact:true}).waitFor();
});
