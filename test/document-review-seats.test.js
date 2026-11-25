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
const chrome=process.env.RUN_BROWSER_SMOKE==='1';
const names={analyst:'sample-author',primary:'sample-primary',secondary:'sample-secondary',admin:'sample-admin'};
async function setup(t,{sqlite=false}={}){
  const root=await mkdtemp(join(tmpdir(),'mvw-review-seats-')),codes={};
  let server,url,revision=0;
  const isolated={root:join(root,'fixtures'),enableIdentityAdmin:true,workspaces:[{id:'north',label:'Sample North'},{id:'south',label:'Sample South'}],
    documentReviewSeats:[{workspace:'north',account:names.secondary}],
    groupApplications:[{workspace:'north',applications:[{id:'sample-app',name:'Fictional app',summary:'Synthetic fixture.'}]}],
    accounts:Object.entries({analyst:'analyst',primary:'reviewer',secondary:'reviewer',admin:'identity-admin'}).map(([key,role])=>{
      const code=codes[key]=randomBytes(32).toString('base64url');
      return {id:names[key],memberships:key==='secondary'?{north:role}:{north:role,south:role},codeHash:codeHash(code)};
    })};
  async function stop(){if(server?.listening){server.closeAllConnections();await new Promise(res=>server.close(res));}}
  async function start(){server=createServer({isolated,sqliteFile:sqlite?join(root,'store.sqlite'):undefined}).listen(0,'127.0.0.1');
    await once(server,'listening');url='http://127.0.0.1:'+server.address().port;}
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});await start();
  async function api(route,status,{token,body,workspace='north'}={}){
    const response=await fetch(url+'/api/'+route+(workspace===null?'':'?workspace='+workspace),{
      method:body===undefined?'GET':'POST',headers:{
        'X-Demo-Actor':'reviewer',...(token?{Cookie:token}:{}),
        ...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await response.json();
    assert.equal(response.status,status,route+' '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=(seat,status=200,workspace='north')=>api('session/login',status,{workspace:null,
    body:{account:names[seat],workspace,code:codes[seat]}});
  const book=token=>api('governance-documents',200,{token});
  async function write(token,action,body={},status=200){
    const result=await api('governance-documents/'+action,status,{token,body:{...body,expectedRevision:revision}});
    if(status===200&&Number.isSafeInteger(result.data.revision))revision=result.data.revision;
    return result.data;
  }
  async function prepare(token,title,attachment=false){
    const data=await write(token,'records',{kind:'policy',title,content:'Fictional text: '+title,links:[]});
    const d=data.documents.find(d=>d.revisions.at(-1).title===title),v=d.revisions.at(-1);
    const path='records/'+d.id+'/revisions/'+v.id;
    if(attachment)await write(token,path+'/attachments',{filename:'synthetic.txt',mediaType:'text/plain',
      data:Buffer.from('Fictional extra file.').toString('base64')});
    await write(token,path+'/submit');
    return {d,v,path};
  }
  return {isolated,codes,api,login,book,write,prepare,get url(){return url;},async restart(){await stop();await start();}};
}
const note={note:'Fictional independent review.'};
test('opt-in secondary reviewer only sees assigned text editions; primary retains separate queue and oversight',async t=>{
  const f=await setup(t,{sqlite:true});
  const a=(await f.login('analyst')).cookie,p=(await f.login('primary')).cookie,s=(await f.login('secondary')).cookie;
  assert.deepEqual((await f.api('session',200,{token:s,workspace:null})).data.capabilities,{views:['governance-docs'],workspaceAudit:false});
  assert.equal((await f.api('session',200,{token:s,workspace:null})).data.actor,'reviewer');
  await f.api('state',200,{token:s});
  assert.deepEqual((await f.api('state',200,{token:s})).data.projects,[]);
  await f.api('group-governance',200,{token:p});
  for(const route of ['workspace-home','my-work','rights/cases','audit/export','reporting/export','workflows/studio','group-governance',
    'operator/v1/jobs','document-access','directory-lifecycle'])await f.api(route,403,{token:s});
  const hidden=await f.prepare(a,'Fictional general queue'),assigned=await f.prepare(a,'Fictional narrow assignment');
  const attached=await f.prepare(a,'Fictional file-backed edition',true);
  assert.deepEqual((await f.book(s)).data.documents,[]);
  await f.write(a,attached.path+'/assign-reviewer',{reviewer:names.secondary},422);
  await f.write(a,assigned.path+'/assign-reviewer',{reviewer:names.primary},422);
  await f.write(s,assigned.path+'/assign-reviewer',{reviewer:names.secondary},403);
  await f.write(a,assigned.path+'/assign-reviewer',{reviewer:names.secondary});
  const now=(await f.book(s)).data;
  assert.deepEqual(now.documents.map(x=>x.id),[assigned.d.id]);
  assert.deepEqual(now.targets,[]);assert.deepEqual(now.legacyRecords,[]);
  assert.equal(now.evidenceRetentionRules,undefined);assert.equal(now.attachmentRules,undefined);
  assert.doesNotMatch(JSON.stringify(now),/Fictional general queue|Fictional file-backed|provisioning|accountProvenance/);
  assert.equal((await f.write(s,hidden.path+'/read',{},404)).code,
    (await f.write(s,hidden.path.replace(hidden.v.id,randomUUID())+'/read',{},404)).code);
  assert.equal((await f.write(s,assigned.path+'/read')).text,'Fictional text: Fictional narrow assignment');
  await f.write(s,assigned.path+'/download',{},403);
  await f.write(s,hidden.path+'/publish',note,404);
  assert.equal((await f.write(p,assigned.path+'/publish',note,409)).code,'REVIEW_ASSIGNED_TO_ANOTHER_ACCOUNT');
  const primaryWork=(await f.api('my-work',200,{token:p})).data.tasks;
  assert.ok(primaryWork.some(task=>task.recordLabel==='Fictional general queue'));
  assert.equal(primaryWork.some(task=>task.recordLabel==='Fictional narrow assignment'),false);
  await f.write(p,hidden.path+'/publish',note);
  const returned=await f.write(s,assigned.path+'/return',note);
  assert.deepEqual(returned.documents,[]);
  await f.write(a,assigned.path+'/submit');
  assert.deepEqual((await f.book(s)).data.documents,[]);
  await f.write(a,assigned.path+'/assign-reviewer',{reviewer:names.secondary});
  await f.write(s,assigned.path+'/publish',note);
  const audit=(await f.api('audit/export',200,{token:p})).data.audit;
  assert.ok(audit.some(row=>row.action==='governance-documents.publish'&&row.entityId===assigned.d.id&&row.account===names.secondary));
});
test('revocation is per account; fresh session cannot regain an old assignment, and duplicate defaults remain closed',async t=>{
  const f=await setup(t),a=(await f.login('analyst')).cookie,p=(await f.login('primary')).cookie;
  let s=(await f.login('secondary')).cookie;
  const admin=(await f.login('admin')).cookie,doc=await f.prepare(a,'Fictional revocation target');
  await f.write(a,doc.path+'/assign-reviewer',{reviewer:names.secondary});
  await f.api('identity-admin',200,{token:admin,body:{target:names.secondary,operation:'revoke',reason:'session-reset',expectedRevision:0}});
  await f.api('governance-documents',401,{token:s});
  s=(await f.login('secondary')).cookie;
  assert.deepEqual((await f.book(s)).data.documents,[]);
  await f.write(s,doc.path+'/read',{},404);
  await f.write(p,doc.path+'/return',note,409);
  await f.write(a,doc.path+'/assign-reviewer',{reviewer:null});
  await f.write(p,doc.path+'/publish',note);
  await f.api('state',200,{token:p});
  await f.login('secondary',401,'south');
  assert.throws(()=>createServer({isolated:{...f.isolated,documentReviewSeats:undefined,groupApplications:undefined}}),/duplicated workspace role/);
  assert.throws(()=>createServer({isolated:f.isolated,corporate:{}}),/only in local synthetic mode/);
});
test('staff role reconfiguration cannot assign an author as their own secondary reviewer',async t=>{
  const f=await setup(t),a=(await f.login('analyst')).cookie;
  const doc=await f.prepare(a,'Fictional prior author edition');
  f.isolated.accounts.find(x=>x.id===names.analyst).memberships.north='reviewer';
  f.isolated.accounts.find(x=>x.id===names.secondary).memberships.north='analyst';
  f.isolated.documentReviewSeats[0].account=names.analyst;
  await f.restart();
  const newAuthor=(await f.login('secondary')).cookie,oldAuthor=(await f.login('analyst')).cookie,primary=(await f.login('primary')).cookie;
  assert.equal((await f.write(newAuthor,doc.path+'/assign-reviewer',{reviewer:names.analyst},422)).code,'REVIEWER_EDITION_INELIGIBLE');
  await f.write(oldAuthor,doc.path+'/publish',note,404);
  await f.write(primary,doc.path+'/publish',note,200);
});
test('Chromium: analyst routes one exact edition and secondary reviewer publishes without broader navigation',{
  skip:!chrome&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:30000
},async t=>{
  const f=await setup(t),a=(await f.login('analyst')).cookie;
  await f.prepare(a,'Fictional browser assigned');await f.prepare(a,'Fictional browser hidden');
  const {chromium}=require('playwright'),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    async function page(seat){
      const p=await browser.newPage();p.setDefaultTimeout(5500);await p.goto(f.url);
      await p.getByLabel('Test account').fill(names[seat]);await p.getByLabel('Workspace ID').fill('north');
      await p.getByLabel('Local access code').fill(f.codes[seat]);await p.getByRole('button',{name:'Sign in',exact:true}).click();
      await p.locator('#show-governance-docs').click();
      return p;
    }
    const analyst=await page('analyst'),secondary=await page('secondary');
    await secondary.getByText('No assigned document reviews are available.',{exact:true}).waitFor();
    const authorDoc=analyst.locator('#governance-docs-view article').filter({has:analyst.getByRole('heading',{name:'Fictional browser assigned',exact:true})});
    await authorDoc.locator('summary').filter({hasText:'Assign a named reviewer'}).click();
    await authorDoc.getByLabel('Named document reviewer').selectOption(names.secondary);
    await authorDoc.getByRole('button',{name:'Assign document review'}).click();
    await authorDoc.getByText('Assigned reviewer: '+names.secondary,{exact:true}).waitFor();
    await secondary.locator('#show-governance-docs').click();
    await secondary.getByRole('heading',{name:'Fictional browser assigned',exact:true}).waitFor();
    assert.equal(await secondary.getByRole('heading',{name:'Fictional browser hidden',exact:true}).count(),0);
    assert.equal(await secondary.getByRole('button',{name:'Download text',exact:true}).count(),0);
    assert.deepEqual(await secondary.locator('#work-tabs button:visible').evaluateAll(nodes=>nodes.map(n=>n.id)),['show-governance-docs']);
    const publish=secondary.locator('details').filter({has:secondary.locator('summary').filter({hasText:/^Publish locally$/})});
    await publish.locator('summary').click();
    await publish.getByLabel('Fictional review rationale').fill('Fictional exact independent approval.');
    await publish.getByRole('button',{name:'Publish locally',exact:true}).click();
    await secondary.getByText('No assigned document reviews are available.',{exact:true}).waitFor();
  }finally{await browser.close();}
});
