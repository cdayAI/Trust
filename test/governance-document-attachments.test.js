'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readFile,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const attachmentPolicy=require('../governance-document-attachments');

const primary='alpha', secondary='beta';
const roles=[
  ['fictional-author',primary,'analyst'],['fictional-reviewer',primary,'reviewer'],
  ['fictional-operator',primary,'case-operator'],['fictional-other',secondary,'analyst']
];
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'mvw-attachment-'));
  const passwords=Object.fromEntries(roles.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const options={root,workspaces:[{id:primary,label:'Synthetic Alpha'},{id:secondary,label:'Synthetic Beta'}],
    accounts:roles.map(([id,workspace,role])=>({id,codeHash:codeHash(passwords[id]),memberships:{[workspace]:role}}))};
  let server,url;
  async function start(){
    server=createServer({isolated:options}).listen(0,'127.0.0.1');
    await once(server,'listening');
    url='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){
    if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  await start();
  async function raw(route,{cookie,body,headers={}}={}){
    const response=await fetch(url+'/api/'+route,{method:body===undefined?'GET':'POST',
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const binary=response.headers.get('content-type')==='application/octet-stream';
    return {response,data:binary?Buffer.from(await response.arrayBuffer()):await response.json()};
  }
  async function request(route,status,options){
    const result=await raw(route,options);
    assert.equal(result.response.status,status,JSON.stringify(result.data));
    return result;
  }
  async function login([account,workspace]){
    const {response}=await request('session/login',200,{body:{account,workspace,code:passwords[account]}});
    return response.headers.get('set-cookie').split(';')[0];
  }
  return {root,start,stop,request,login, get url(){return url;},passwords,options};
}
const collection='governance-documents';
const original='Fictional attachment fixture.\r\nRésumé for a simulated review.\r\n';
const filename='Fictional  sample.TXT';
const cleanFilename='Fictional sample.txt';
const payload={filename,mediaType:'text/plain',data:Buffer.from(original).toString('base64')};
const doc={kind:'policy',title:'Fictional upload policy',content:'Fictional standalone policy text.',links:[]};
test('document attachments: scoped, bounded, immutable and audited roundtrip over local isolated HTTP',async t=>{
  const {root,request,login,stop,start}=await fixture(t);
  const cookies=await Promise.all(roles.map(login));
  let [author,reviewer,operator,other]=cookies;
  let revision=0;
  async function post(path,body,status=200,cookie=author,workspace=primary,headers){
    const {response,data}=await request(collection+'/'+path+'?workspace='+workspace,status,{cookie,body:{expectedRevision:revision,...body},headers});
    if(status===200&&!Buffer.isBuffer(data)&&Number.isSafeInteger(data.revision))revision=data.revision;
    return {response,data};
  }
  const created=(await post('records',doc)).data;
  const d=created.documents[0],v=d.revisions[0];
  const rev='records/'+d.id+'/revisions/'+v.id,uploads=rev+'/attachments';
  assert.deepEqual(v.attachments,[]);
  assert.equal(created.attachmentRules.maxFileBytes,16*1024);
  await post(uploads,payload,403,reviewer);
  await post(uploads,payload,403,reviewer,primary,{'X-Demo-Actor':'analyst'});
  await post(uploads,payload,401,null);
  await post(uploads,payload,403,other,primary);
  await post(uploads,{...payload,expectedRevision:0},404,other,secondary);
  await post(uploads,{...payload,expectedRevision:0},409);
  for(const invalid of [
    {...payload,filename:'fictional.pdf'},
    {...payload,filename:'../fictional.txt'},
    {...payload,filename:'CON.txt'},
    {...payload,filename:'fictional\r\n.txt'},
    {...payload,data:'not valid base64!'},
    {...payload,data:''}
  ])await post(uploads,invalid,422);
  for(const invalid of [
    {...payload,mediaType:'application/pdf'},
    {...payload,data:Buffer.from([0xF0,0x28,0x8C,0xBC]).toString('base64')},
    {...payload,data:Buffer.from([0x41,0x00,0x42]).toString('base64')},
    {...payload,data:Buffer.from('<html>fictional markup fixture</html>').toString('base64')}
  ])await post(uploads,invalid,415);
  await post(uploads,{...payload,data:Buffer.alloc(16*1024+1,65).toString('base64')},413);
  await post(uploads,{...payload,data:'A'.repeat(33000)},413);
  const booked=(await post(uploads,payload)).data;
  const item=booked.documents[0].revisions[0].attachments[0];
  assert.deepEqual(Object.keys(item).sort(),['id','mediaType','name','sha256','size']);
  assert.match(item.id,/^[a-f0-9-]{36}$/);
  assert.equal(item.name,cleanFilename);
  assert.equal(item.mediaType,'text/plain');
  assert.equal(item.size,Buffer.byteLength(original));
  assert.equal(item.sha256,createHash('sha256').update(original).digest('hex'));
  const attachment=uploads+'/'+item.id,view=collection+'?workspace=alpha';
  await request(collection+'/must-not-exist?workspace=alpha',404,{cookie:author});
  assert.deepEqual((await request(view,200,{cookie:operator})).data.documents,[]);
  await request(collection+'/'+attachment+'/download?workspace=alpha',404,{cookie:author}); // no public GET route
  await post(attachment+'/download',{},404,operator);
  await post(attachment+'/download',{},404,other,secondary);
  const download=await post(attachment+'/download',{},200,reviewer);
  assert.equal(download.data.toString(),original);
  assert.equal(download.response.headers.get('content-disposition'),'attachment; filename="'+cleanFilename+'"');
  assert.equal(download.response.headers.get('content-type'),'application/octet-stream');
  assert.match(download.response.headers.get('content-security-policy'),/^sandbox/);
  assert.equal(download.response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(download.response.headers.get('cache-control'),'no-store');
  for(let i=0;i<3;i++)await post(uploads,{...payload,filename:'Fictional-'+i+'.txt'});
  await post(uploads,payload,409);
  let current=(await request(view,200,{cookie:author})).data.documents[0].revisions[0];
  assert.equal(current.attachments.length,4);
  const removed=current.attachments.at(-1);
  await post(uploads+'/'+removed.id+'/remove',{},403,reviewer);
  await post(uploads+'/'+removed.id+'/remove',{},200,author);
  await post(uploads+'/'+removed.id+'/download',{},404,author);
  await post(rev+'/submit',{});
  assert.equal((await post(uploads,payload,409)).data.code,'OUT_OF_ORDER');
  await post(rev+'/return',{note:'Synthetic documents review.'},200,reviewer);
  await post(uploads,{...payload,filename:'Fictional returned.txt'});
  await post(rev+'/submit',{});
  await post(rev+'/publish',{note:'Reviewed only the fictional fixture.'},200,reviewer);
  assert.equal((await post(attachment+'/remove',{},409)).data.code,'IMMUTABLE_REVISION');
  assert.equal((await post(uploads,payload,409)).data.code,'IMMUTABLE_REVISION');
  assert.equal((await post(attachment+'/download',{},200,operator)).data.toString(),original);
  const newRevision=await post('records/'+d.id+'/revise',{title:'Fictional next edition',content:'No automatic file carryover.',links:[]});
  assert.deepEqual(newRevision.data.documents[0].revisions.at(-1).attachments,[]);
  assert.equal(newRevision.data.documents[0].revisions[0].attachments[0].id,item.id);
  const unauthorizedPayloadText=['Résumé for a simulated review.',payload.data,cleanFilename];
  for(const route of ['state','audit/export','work-queue']){
    const {data}=await request(route+'?workspace=alpha',200,{cookie:reviewer});
    for(const secret of unauthorizedPayloadText)assert.equal(JSON.stringify(data).includes(secret),false);
  }
  const audit=(await request('audit/export?workspace=alpha',200,{cookie:reviewer})).data.audit;
  assert.equal(audit.find(e=>e.action===collection+'.attachment-upload').account,roles[0][0]);
  assert.equal(audit.find(e=>e.action===collection+'.attachment-download').details.attachmentId,item.id);
  assert.ok(audit.some(e=>e.action===collection+'.attachment-remove'));
  assert.ok(audit.some(e=>e.action===collection+'.refused'&&e.details.action==='attachment-download'));
  assert.equal(JSON.stringify((await request(view,200,{cookie:reviewer})).data).includes(payload.data),false);
  await stop();await start();
  author=await login(roles[0]);reviewer=await login(roles[1]);
  const reopened=(await post(attachment+'/download',{},200,reviewer)).data;
  assert.equal(reopened.toString(),original);
  await stop();
  const snapshotPath=join(root,primary,'state.json');
  const snapshot=JSON.parse(await readFile(snapshotPath,'utf8'));
  snapshot.governanceDocuments.documents[0].revisions[0].attachments[0].sha256='0'.repeat(64);
  await writeFile(snapshotPath,JSON.stringify(snapshot),{mode:0o600});
  await start();reviewer=await login(roles[1]);
  assert.equal((await post(attachment+'/download',{},409,reviewer)).data.code,'ATTACHMENT_UNAVAILABLE');
});
test('attachment parser enforces exact file/workspace bounds before persisting',()=>{
  const version={attachments:[]}, entry={size:attachmentPolicy.rules.maxWorkspaceBytes};
  const book={documents:[{revisions:[version]}]};
  const cap={...payload,data:Buffer.alloc(attachmentPolicy.rules.maxFileBytes,65).toString('base64')};
  assert.equal(attachmentPolicy.attachment(cap,book,version).size,16*1024);
  book.documents.push({revisions:[{attachments:[entry]}]});
  assert.throws(()=>attachmentPolicy.attachment(payload,book,version),{code:'ATTACHMENT_WORKSPACE_LIMIT'});
  book.documents[1].revisions[0].attachments=Array.from({length:attachmentPolicy.rules.maxFilesPerWorkspace},()=>({size:1}));
  assert.throws(()=>attachmentPolicy.attachment(payload,book,version),{code:'ATTACHMENT_WORKSPACE_LIMIT'});
});
test('browser: governance file picker enforces limits and uploads, downloads, removes and locks fictional attachments',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30_000
},async t=>{
  const {chromium}=require('playwright');
  const f=await fixture(t);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try{
    const analyst=await browser.newPage(),reviewer=await browser.newPage();
    const errors=[],external=[];
    for(const page of [analyst,reviewer]){
      page.setDefaultTimeout(6000);
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>{
        if(new URL(route.request().url()).origin===f.url)return route.continue();
        external.push(route.request().url());return route.abort();
      });
    }
    async function signIn(page,[account,workspace]){
      await page.goto(f.url);
      await page.getByLabel('Test account',{exact:true}).fill(account);
      await page.getByLabel('Workspace ID',{exact:true}).fill(workspace);
      await page.getByLabel('Local access code',{exact:true}).fill(f.passwords[account]);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
    }
    await signIn(analyst,roles[0]);
    await analyst.getByText('Draft a document',{exact:true}).click();
    await analyst.getByLabel('Fictional title',{exact:true}).fill(doc.title);
    await analyst.getByLabel('Original fictional text',{exact:true}).fill(doc.content);
    await analyst.getByRole('button',{name:'Create document draft',exact:true}).click();
    const picker=analyst.getByLabel('Fictional .txt attachment',{exact:true});
    const upload=analyst.getByRole('button',{name:'Upload attachment',exact:true});
    await picker.setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:Buffer.from('Fictional unsupported file')});
    await upload.click();
    await analyst.getByRole('status').getByText('Only fictional UTF-8 .txt files are accepted.',{exact:true}).waitFor();
    await picker.setInputFiles({name:'large.txt',mimeType:'text/plain',buffer:Buffer.alloc(16*1024+1,65)});
    await upload.click();
    await analyst.getByRole('status').getByText(/no larger than 16 KiB/).waitFor();
    await picker.setInputFiles({name:filename,mimeType:'text/plain',buffer:Buffer.from(original)});
    await upload.click();
    await analyst.getByRole('button',{name:'Remove attachment '+cleanFilename,exact:true}).waitFor();
    const [download]=await Promise.all([analyst.waitForEvent('download'),analyst.getByRole('button',{name:'Download attachment '+cleanFilename,exact:true}).click()]);
    assert.equal(download.suggestedFilename(),cleanFilename);
    const chunks=[];
    for await (const chunk of await download.createReadStream())chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(),original);
    assert.equal(await analyst.getByText(original.trim(),{exact:true}).count(),0);
    await analyst.getByRole('button',{name:'Remove attachment '+cleanFilename,exact:true}).click();
    await analyst.getByText('No attachments.',{exact:true}).waitFor();
    await picker.setInputFiles({name:filename,mimeType:'text/plain',buffer:Buffer.from(original)});
    await upload.click();
    await analyst.getByRole('button',{name:'Remove attachment '+cleanFilename,exact:true}).waitFor();
    await analyst.getByRole('button',{name:'Submit for review',exact:true}).click();
    await analyst.getByText('review',{exact:true}).waitFor();
    assert.equal(await upload.count(),0);
    await signIn(reviewer,roles[1]);
    await reviewer.getByRole('button',{name:'Download attachment '+cleanFilename,exact:true}).waitFor();
    assert.equal(await reviewer.getByRole('button',{name:'Upload attachment',exact:true}).count(),0);
    const panel=reviewer.locator('details').filter({has:reviewer.locator('summary').getByText('Publish locally',{exact:true})});
    await panel.locator('summary').click();
    await panel.getByLabel('Fictional review rationale',{exact:true}).fill('Reviewed a fictional text attachment.');
    await panel.getByRole('button',{name:'Publish locally',exact:true}).click();
    await reviewer.getByText('Current',{exact:true}).waitFor();
    await analyst.reload();
    await analyst.getByRole('button',{name:'Policies and documents',exact:true}).click();
    await analyst.getByRole('button',{name:'Download attachment '+cleanFilename,exact:true}).waitFor();
    assert.equal(await analyst.getByRole('button',{name:'Remove attachment '+cleanFilename,exact:true}).count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await browser.close();}
});
