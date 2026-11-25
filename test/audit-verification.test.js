'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash,randomBytes}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const {verifyBytes}=require('../audit-verification');
const audit='/api/audit-management',risk='/api/risk-controls';
const hash=x=>createHash('sha256').update(x).digest('hex');
const encode=x=>Buffer.from(JSON.stringify(x,null,2)+'\n','utf8');
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const manifest=x=>{x.manifestSha256=hash(JSON.stringify(sort(x.manifest)));return x;};
async function listen(server){
  server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;
}
async function seed(post,read,tag,{close=true}={}){
  const board=await read(risk);
  const control=(await post(risk+'/controls',{expectedRevision:board.revision,title:'Fictional control '+tag,intent:'Test fictional workflow'})).controls.at(-1);
  let response=await post(audit+'/plans',{controlIds:[control.id],title:'Fictional audit '+tag,objective:'Check fictional control',scope:'Fictional scope '+tag});
  const plan=response.plans.at(-1);
  const route=audit+'/plans/'+plan.id;
  response=await post(route+'/begin',{expectedRevision:1});
  const p=()=>response.plans.find(x=>x.id===plan.id);
  response=await post(route+'/assess',{expectedRevision:p().revision,controlId:control.id,outcome:'exception',observation:'Fictional deficiency.',
    evidenceReference:'SYN-AUDIT-01',severity:'high',correctiveAction:'Add fictional verification.'});
  const finding=p().assessments.at(-1).finding;
  response=await post(route+'/submit',{expectedRevision:p().revision});
  await post(route+'/finalize',{expectedRevision:p().revision,note:'Fictional independent review.'},'reviewer');
  response=await post(audit+'/remediations',{findingId:finding.id,action:'Apply a fictional improvement.',dueDate:'2180-01-01'});
  const action=response.remediation[plan.id][0].action;
  const closure=audit+'/remediations/'+action.id;
  if(close){
    const controls=await read(risk);
    const retests=await post(risk+'/tests',{expectedRevision:controls.revision,controlId:control.id,outcome:'pass',
      evidenceReference:'SYN-RETEST01',note:'Fictional retest evidence.'});
    const passing=retests.tests.at(-1);
    await post(risk+'/tests/'+passing.id+'/accept',{expectedRevision:retests.revision,note:'Accept fictional retest.'},'reviewer');
    response=await post(closure+'/submit',{expectedRevision:action.revision,testId:passing.id,result:'Fictional control improvement passed.'});
    await post(closure+'/close',{expectedRevision:response.remediation[plan.id][0].action.revision,note:'Close fictional issue.'},'reviewer');
  }
  return {plan,route,action,closure,control};
}
function fixture(url){
  return async(route,{actor,cookie,body,expected=200,workspace}={})=>{
    const res=await fetch(url+route+(workspace?(route.includes('?')?'&':'?')+'workspace='+workspace:''),{
      method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...(actor?{'X-Demo-Actor':actor}:{}),...(cookie?{Cookie:cookie}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const bytes=Buffer.from(await res.arrayBuffer());assert.equal(res.status,expected,route+': '+bytes.toString());
    return {res,bytes,data:JSON.parse(bytes)};
  };
}
test('offline audit verifier rejects non-regular inputs without waiting for a writer',async t=>{
  const root=await mkdtemp(join(tmpdir(),'audit-verifier-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=process.platform==='win32'?root:join(root,'synthetic-audit-source');
  if(process.platform!=='win32')execFileSync('mkfifo',[source]);
  assert.throws(()=>execFileSync(process.execPath,[join(__dirname,'..','scripts','verify-audit-package.js'),source],
    {stdio:'pipe',timeout:2500}),error=>error.status===1&&error.stderr.toString().includes('Audit package verification failed'));
});

test('SQLite offline package is scoped and byte-identical to independent report exports; malformed packages fail closed',async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-audit-verification-'));
  const roster=[['alpha-analyst','alpha','analyst'],['alpha-reviewer','alpha','reviewer'],['alpha-case','alpha','case-operator'],['beta-analyst','beta','analyst']];
  const codes=Object.fromEntries(roster.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'workspaces'),workspaces:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],
    accounts:roster.map(([id,space,role])=>({id,codeHash:codeHash(codes[id]),memberships:{[space]:role}}))};
  let server,request;
  async function start(){server=createServer({isolated,sqliteFile:join(root,'workbench.sqlite')});request=fixture(await listen(server))}
  async function stop(){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  const cookies={};
  async function login(){
    for(const [account,workspace,role] of roster){
      const {res}=await request('/api/session/login',{body:{account,workspace,code:codes[account]}});
      cookies[workspace==='beta'?'beta':role]=res.headers.get('set-cookie').split(';')[0];
    }
  }
  await login();
  const scoped=(route,role='analyst',opts={},workspace='alpha')=>request(route,{cookie:cookies[role],workspace,...opts});
  const post=async(route,body,role='analyst')=>(await scoped(route,role,{body})).data;
  const read=async route=>(await scoped(route)).data;
  const target=await seed(post,read,'TARGET');
  const unrelated=await seed(post,read,'UNRELATED');
  const draft=await post(audit+'/plans',{controlIds:[target.control.id],title:'Draft',objective:'Synthetic description',scope:'Synthetic scope'});
  await scoped(audit+'/plans/'+draft.plans.at(-1).id+'/package','analyst',{expected:409});
  const path=target.route+'/package';
  await request(path,{expected:401,workspace:'alpha'});
  await scoped(path,'case-operator',{expected:403,actor:'reviewer'});
  await scoped(path,'beta',{expected:403});
  await scoped(path,'beta',{expected:404},'beta');
  await scoped(path+'?audit='+unrelated.plan.id,'reviewer',{expected:422});
  await scoped(path,'reviewer',{body:{audit:unrelated.plan.id},expected:404});
  const original=await scoped(path,'reviewer');
  assert.match(original.res.headers.get('content-disposition'),/^attachment; filename="synthetic-audit-package-/);
  const {data:packageObj,bytes}=original;
  const result=verifyBytes(bytes);
  const anchor=packageObj.manifestSha256;
  assert.equal(result.verification,'internal-checksums-only');
  assert.equal(result.signatureAuthenticity,false);
  assert.equal(result.approvedClosures,1);
  assert.deepEqual(result.scope,{mode:'local-isolated',workspace:'alpha',actor:'alpha-reviewer',role:'reviewer'});
  assert.equal(result.auditId,target.plan.id);
  assert.equal(verifyBytes(bytes,{expectedManifestSha256:anchor}).verification,'independently-recorded-checksum-matched');
  const report=await scoped(target.route+'/report','reviewer');
  const closure=await scoped(target.closure+'/report','reviewer');
  assert.ok(Buffer.from(packageObj.files[0].base64,'base64').equals(report.bytes));
  assert.ok(Buffer.from(packageObj.files[1].base64,'base64').equals(closure.bytes));
  assert.equal(packageObj.manifest.entries[1].findingId,target.action.finding.id);
  assert.equal(packageObj.manifest.entries.some(e=>e.actionId===unrelated.action.id),false);

  const tamper=mutate=>{const copy=structuredClone(packageObj);mutate(copy);return encode(copy)};
  const refused=(fn,code='AUDIT_PACKAGE_DIGEST')=>assert.throws(()=>verifyBytes(tamper(fn)),{code});
  refused(copy=>{copy.manifest.scope.actor='another-fictional-account'});
  refused(copy=>{copy.files[0].base64=(copy.files[0].base64[0]==='A'?'B':'A')+copy.files[0].base64.slice(1)});
  refused(copy=>copy.files.pop(),'AUDIT_PACKAGE_MANIFEST');
  refused(copy=>{copy.manifest.entries.push(structuredClone(copy.manifest.entries[1]));copy.files.push({...copy.files[1]});manifest(copy)},'AUDIT_PACKAGE_ENTRY');
  refused(copy=>{copy.manifest.entries[1].receipts.push({...copy.manifest.entries[1].receipts[0]});manifest(copy)},'AUDIT_PACKAGE_REFERENCE');
  refused(copy=>{copy.manifest.entries[1].findingId=unrelated.action.finding.id;manifest(copy)},'AUDIT_PACKAGE_REFERENCE');
  refused(copy=>{copy.manifest.entries[1].receipts[0].testId=unrelated.control.id;manifest(copy)},'AUDIT_PACKAGE_RECEIPT');
  assert.throws(()=>verifyBytes(tamper(copy=>{copy.manifest.entries.pop();copy.files.pop();manifest(copy)}),{expectedManifestSha256:anchor}),
    {code:'AUDIT_PACKAGE_EXPECTED_DIGEST'});
  assert.throws(()=>verifyBytes(Buffer.from(bytes.toString().replace('"manifest": {','"manifest": {},\n  "manifest": {'))),{code:'AUDIT_PACKAGE_SHAPE'});
  const cliFile=join(root,'audit-package.json');
  await writeFile(cliFile,bytes);
  const cli=JSON.parse(execFileSync(process.execPath,[join(__dirname,'..','scripts','verify-audit-package.js'),cliFile,'--expected-manifest-sha256',anchor]));
  assert.deepEqual(cli,verifyBytes(bytes,{expectedManifestSha256:anchor}));
  await writeFile(cliFile,tamper(copy=>copy.files.pop()));
  assert.throws(()=>execFileSync(process.execPath,[join(__dirname,'..','scripts','verify-audit-package.js'),cliFile],{stdio:'pipe'}),{status:1});

  const pending=await seed(post,read,'PENDING',{close:false});
  const unclosed=(await scoped(pending.route+'/package','reviewer')).data;
  assert.equal(unclosed.manifest.entries.length,1);
  await stop();await start();await login();
  assert.ok((await scoped(path,'reviewer')).bytes.equals(bytes));
  const analyst=(await scoped(path,'analyst')).data;
  assert.equal(analyst.manifest.scope.actor,'alpha-analyst');
  assert.notEqual(analyst.manifestSha256,anchor);
  assert.deepEqual(analyst.files,packageObj.files);
});

test('Chromium downloads a finalized package without replacing the original report link',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30_000
},async t=>{
  const {chromium}=require('playwright');
  const dir=await mkdtemp(join(tmpdir(),'trust-audit-verification-browser-'));
  const server=createServer({dataFile:join(dir,'workbench.json')});
  const url=await listen(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})});
  const request=fixture(url);
  const post=async(route,body,actor='analyst')=>(await request(route,{body,actor})).data;
  const read=async route=>(await request(route)).data;
  const auditCase=await seed(post,read,'BROWSER');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});page.setDefaultTimeout(6500);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button',{name:'Browse workspace'}).click();
    await page.getByRole('button',{name:'Audit management',exact:true}).click();
    await page.getByRole('link',{name:'Download finalized report JSON',exact:true}).waitFor();
    await page.getByLabel('Demo identity').selectOption('reviewer');
    const event=page.waitForEvent('download');
    await page.getByRole('link',{name:'Download offline audit package',exact:true}).click();
    const received=await event,chunks=[];
    assert.equal(received.suggestedFilename(),'synthetic-audit-package-'+auditCase.plan.id+'.json');
    for await(const chunk of await received.createReadStream())chunks.push(chunk);
    const checked=verifyBytes(Buffer.concat(chunks));
    assert.equal(checked.auditId,auditCase.plan.id);
    assert.equal(checked.approvedClosures,1);
    assert.deepEqual(checked.scope,{mode:'synthetic-demo',workspace:null,actor:'reviewer',role:'reviewer'});
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
