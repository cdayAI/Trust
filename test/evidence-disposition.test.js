'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {createServer}=require('../server');
const {backupDatabase,restoreDatabase,openSqlite}=require('../durable-storage');
const {codeHash}=require('../workspace-access');
const {verifyEvidenceSnapshot}=require('../governance-documents');

const runtime={alice:'analyst',bob:'reviewer',carol:'case-operator'};
const base='/api/governance-documents',retention='/api/retention';
const sample=Buffer.from('Fictional evidence retained.\r\n');
const asOf='2199-12-30';
const metadata={kind:'policy',title:'Fictional simulated disposition',content:'No evidence is deleted.',links:[]};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'trust-evidence-rehearsal-'));
  let sqliteFile=join(dir,'fixture.sqlite'),server,origin;
  const code=Object.fromEntries(Object.keys(runtime).map(name=>[name,randomBytes(32).toString('base64url')]));
  const isolated={root:join(dir,'workspaces'),workspaces:[{id:'alpha',label:'Fictional Alpha'},{id:'beta',label:'Fictional Beta'}],
    accounts:Object.entries(runtime).map(([id,role])=>({id,codeHash:codeHash(code[id]),memberships:{alpha:role,beta:role}}))};
  async function start(){
    server=createServer({sqliteFile,isolated}).listen(0,'127.0.0.1');
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
    const res=await fetch(url,{
      method:body===undefined?'GET':'POST',
      headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{origin,'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6000)
    });
    const value=res.headers.get('content-type')==='application/octet-stream'?Buffer.from(await res.arrayBuffer()):await res.json();
    if(status!==undefined)assert.equal(res.status,status,JSON.stringify(value));
    return {value,res};
  }
  const login=async(account,workspace='alpha')=>(await api('/api/session/login',200,{body:{account,workspace,code:code[account]},workspace:null}))
    .res.headers.get('set-cookie').split(';')[0];
  function swap(){
    [isolated.accounts[0].memberships.alpha,isolated.accounts[1].memberships.alpha]=[
      isolated.accounts[1].memberships.alpha,isolated.accounts[0].memberships.alpha
    ];
  }
  return {dir,start,stop,api,login,swap,code,get origin(){return origin;},get file(){return sqliteFile;},setFile:value=>{sqliteFile=value;}};
}
async function workflow(f){
  let author,reviewer,operator,docsRevision=0,ruleRevision=0;
  async function login(){[author,reviewer,operator]=await Promise.all(['alice','bob','carol'].map(x=>f.login(x)));}
  await login();
  async function post(path,body,status=200,cookie=author,workspace='alpha'){
    const isRule=path.startsWith(retention+'/');
    const {value}=await f.api(path,status,{cookie,workspace,body:{
      expectedRevision:isRule?ruleRevision:docsRevision,...body
    }});
    if(status===200&&Number.isSafeInteger(value.revision)){
      if(isRule)ruleRevision=value.revision;
      else docsRevision=value.revision;
    }
    return value;
  }
  async function rule(fields={}){
    const started=await post(retention+'/schedules',{category:'demo-operations',title:'Fictional retention rule',trigger:'created',
      days:2,disposition:'delete',...fields});
    const id=started.schedules.at(-1).id,p=retention+'/schedules/'+id;
    await post(p+'/submit',{});
    return (await post(p+'/activate',{note:'Fictional rule approval.'},200,reviewer)).schedules.find(r=>r.id===id);
  }
  async function draft(){
    const created=await post(base+'/records',metadata),doc=created.documents.at(-1),edition=doc.revisions[0];
    const path=base+'/records/'+doc.id+'/revisions/'+edition.id;
    return {doc,edition,path};
  }
  async function publish(path){
    await post(path+'/submit',{});
    return post(path+'/publish',{note:'Fictional independently reviewed edition.'},200,reviewer);
  }
  async function hold(path){
    const model=await post(path+'/evidence-hold/place',{reason:'audit-review'});
    return model.documents.flatMap(d=>d.revisions).find(v=>path.endsWith(v.id)).evidenceHold.id;
  }
  async function release(path,id){
    const fields={holdId:id,reason:'review-complete'};
    await post(path+'/evidence-hold/request-release',fields);
    await post(path+'/evidence-hold/approve-release',fields,200,reviewer);
  }
  return {post,rule,draft,publish,hold,release,login,get docsRevision(){return docsRevision;},
    get author(){return author;},get reviewer(){return reviewer;},get operator(){return operator;}};
}
const ruleBody=rule=>({scheduleId:rule.id,scheduleVersion:rule.version,asOf});
const selected=(model,id)=>model.documents.flatMap(x=>x.revisions).find(x=>x.id===id);

test('audit-only evidence disposition refuses held, stale, superseded and unauthorized requests',async t=>{
  const f=await fixture(t),w=await workflow(f);
  const v1=await w.rule();
  const closed=await w.rule({category:'demo-customer',trigger:'closed'});
  const {doc,edition,path}=await w.draft();
  const endpoint=path+'/evidence-disposition';
  const request=(body,status=200,cookie=w.author,workspace='alpha')=>w.post(endpoint+'/preview',body,status,cookie,workspace);
  const run=(id,status=200,cookie=w.reviewer,version)=>w.post(endpoint+'/rehearse',{previewId:id,...(version===undefined?{}:{expectedRevision:version})},status,cookie);
  assert.equal((await request(ruleBody(v1),409)).code,'EVIDENCE_REHEARSAL_EDITION');
  const attachment=selected(await w.post(path+'/attachments',{filename:'fictional-rehearsal.txt',mediaType:'text/plain',data:sample.toString('base64')}),edition.id).attachments[0];
  await w.publish(path);
  assert.equal((await request(ruleBody(v1),403,w.reviewer)).code,'ACCESS_DENIED');
  const beta=await f.login('alice','beta');
  await request(ruleBody(v1),403,beta);
  await request({...ruleBody(v1),expectedRevision:0},404,beta,'beta');
  const hidden=(await f.api(base,200,{cookie:w.operator})).value;
  assert.equal(hidden.evidenceRetentionRules,undefined);
  assert.equal(selected(hidden,edition.id).evidenceRehearsal,undefined);
  assert.equal((await request(ruleBody(closed),409)).code,'EVIDENCE_TRIGGER_MISSING');
  assert.equal((await request({...ruleBody(v1),asOf:'2000-01-01'},409)).code,'EVIDENCE_NOT_DUE');
  assert.equal((await request({...ruleBody(v1),asOf:'2026-02-30'},422)).code,'INVALID_DATE');
  assert.equal((await request({...ruleBody(v1),scheduleVersion:v1.version+1},409)).code,'EVIDENCE_RULE_STALE');

  const placed=await w.hold(path);
  assert.equal((await request(ruleBody(v1),409)).code,'EVIDENCE_ACTIVE_HOLD');
  await w.release(path,placed);
  let row=selected(await request(ruleBody(v1)),edition.id).evidenceRehearsal;
  assert.equal(row.scheduleId,v1.id);
  assert.equal(row.scheduleVersion,v1.version);
  assert.equal(row.status,'requested');
  const heldAgain=await w.hold(path);
  assert.equal((await run(row.id,409)).code,'EVIDENCE_ACTIVE_HOLD');
  await w.post(path+'/evidence-hold/request-release',{holdId:heldAgain,reason:'review-complete'});
  assert.equal((await run(row.id,409)).code,'EVIDENCE_ACTIVE_HOLD');
  await w.post(path+'/evidence-hold/approve-release',{holdId:heldAgain,reason:'review-complete'},200,w.reviewer);
  assert.equal((await run(row.id,409)).code,'EVIDENCE_PREVIEW_STALE');
  const obsolete=row.id;
  row=selected(await request(ruleBody(v1)),edition.id).evidenceRehearsal;
  assert.equal((await run(obsolete,409)).code,'EVIDENCE_PREVIEW_CONFLICT');

  const v2=await w.rule({days:7,disposition:'archive'});
  assert.equal((await run(row.id,409)).code,'EVIDENCE_PREVIEW_STALE');
  assert.equal((await request(ruleBody(v1),409)).code,'EVIDENCE_RULE_STALE');
  const current=selected(await request(ruleBody(v2)),edition.id).evidenceRehearsal;
  assert.notEqual(current.id,row.id);
  const newDraft=(await w.post(base+'/records/'+doc.id+'/revise',{title:'Fictional successor',content:'Different bytes',links:[]}))
    .documents.find(x=>x.id===doc.id).revisions[1];
  const successor=base+'/records/'+doc.id+'/revisions/'+newDraft.id;
  await w.publish(successor);
  assert.equal((await w.post(successor+'/evidence-disposition/rehearse',{previewId:current.id},404,w.reviewer)).code,'EVIDENCE_PREVIEW_NOT_FOUND');
  assert.equal((await run(current.id,409,w.reviewer,w.docsRevision-1)).code,'STALE_REVISION');

  await f.stop();f.swap();await f.start();
  const newReviewer=await f.login('alice');
  assert.equal((await run(current.id,403,newReviewer)).code,'EVIDENCE_REHEARSAL_INDEPENDENCE');
  await f.stop();f.swap();await f.start();await w.login();
  const before=selected((await f.api(base,200,{cookie:w.author})).value,edition.id);
  const after=selected(await run(current.id),edition.id);
  const {result}=after.evidenceRehearsal;
  assert.equal(after.evidenceRehearsal.status,'rehearsed');
  assert.deepEqual([result.mode,result.changedEvidence,result.deleted],['audit-only',false,false]);
  assert.deepEqual({...after,evidenceRehearsal:undefined},{...before,evidenceRehearsal:undefined});
  assert.equal((await run(current.id,409)).code,'EVIDENCE_PREVIEW_CONFLICT');
  assert.equal((await request(ruleBody(v2),409)).code,'EVIDENCE_ALREADY_REHEARSED');
  const audit=(await f.api('/api/audit/export',200,{cookie:w.reviewer})).value.audit
    .filter(e=>e.action==='governance-documents.evidence-disposition.rehearse');
  assert.equal(audit.length,1);
  assert.equal(audit[0].details.receiptId,result.id);
  assert.equal(audit[0].details.versionId,edition.id);
  assert.equal(audit[0].details.scheduleVersion,v2.version);
  assert.equal(audit[0].account,'bob');
  assert.doesNotMatch(JSON.stringify(audit),/fictional-rehearsal\.txt|Fictional evidence retained/);

  // Restore the receipt, including its historical rule after a later publish.
  await w.rule({days:30,disposition:'anonymize'});
  await f.stop();
  const backup=join(f.dir,'backup.json'),restored=join(f.dir,'restored.sqlite');
  backupDatabase(f.file,backup);restoreDatabase(backup,restored);f.setFile(restored);
  const restoredDb=openSqlite(restored,{readOnly:true});
  try{
    const snapshot=restoredDb.snapshot().documents.find(d=>d.scope==='workspace:alpha'&&d.kind==='workbench').payload;
    const broken=structuredClone(snapshot);
    broken.governanceDocuments.evidenceDisposition.rows.at(-1).decision.deleted=true;
    assert.throws(()=>verifyEvidenceSnapshot(broken),/disposition rehearsals/);
  }finally{restoredDb.close();}
  await f.start();await w.login();
  const reopened=selected((await f.api(base,200,{cookie:w.author})).value,edition.id);
  assert.equal(reopened.evidenceRehearsal.result.id,result.id);
  const bytes=await f.api(path+'/attachments/'+attachment.id+'/download',200,{cookie:w.reviewer,body:{}});
  assert.deepEqual(bytes.value,sample);
  assert.equal(bytes.res.headers.get('content-disposition'),'attachment; filename="fictional-rehearsal.txt"');
});

test('Chromium shows fictional rule pin, independent receipt and unchanged edition text',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Run with pinned Chromium',timeout:35_000
},async t=>{
  const {chromium}=require('playwright'),f=await fixture(t),w=await workflow(f);
  const rule=await w.rule(),{path}=await w.draft();await w.publish(path);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(8500);
  async function signIn(name){
    await page.goto(f.origin);
    await page.getByLabel('Test account',{exact:true}).fill(name);
    await page.getByLabel('Workspace ID',{exact:true}).fill('alpha');
    await page.getByLabel('Local access code',{exact:true}).fill(f.code[name]);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
  }
  await signIn('alice');
  const panel=page.locator('details').filter({has:page.locator('summary').getByText('Preview evidence disposition',{exact:true})});
  await panel.locator('summary').click();
  await panel.getByLabel('Fictional retention rule',{exact:true}).selectOption(rule.id);
  await panel.getByLabel('Fictional as-of date',{exact:true}).fill(asOf);
  await panel.getByRole('button',{name:'Preview evidence disposition',exact:true}).click();
  await page.getByText('Preview awaiting independent rehearsal.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Record rehearsal only',exact:true}).count(),0);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await signIn('bob');
  await page.getByRole('button',{name:'Record rehearsal only',exact:true}).click();
  await page.getByText(/^Rehearsal recorded · evidence retained/).waitFor();
  await page.getByRole('button',{name:'View fictional text',exact:true}).click();
  await page.getByText(metadata.content,{exact:true}).waitFor();
});
