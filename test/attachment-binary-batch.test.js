'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {createHash,randomBytes}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {performance}=require('node:perf_hooks');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const {backupDatabase,restoreDatabase}=require('../durable-storage');
const transport=require('../attachment-binary-batch');

const MiB=1024*1024, digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const roles={author:'analyst',reviewer:'reviewer',operator:'case-operator'};
const base='/api/governance-documents';
const doc={kind:'policy',title:'Large fictional PDF fixture',content:'Synthetic experiment only.',links:[],expectedRevision:0};
function pdfAtLeast(size){
  const head=Buffer.from('%PDF-1.4\n');
  const comments=Buffer.alloc(size,0x41);
  for(let i=0;i<comments.length;i++){if(i%60===0)comments[i]=37;else if(i%60===59)comments[i]=10;}
  comments[comments.length-1]=10;
  const root=Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const pages=Buffer.from('2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n');
  const position=head.length+comments.length;
  const pad=number=>String(number).padStart(10,'0');
  const xref=Buffer.from('xref\n0 3\n0000000000 65535 f \n'+pad(position)+' 00000 n \n'+pad(position+root.length)+' 00000 n \n'+
    'trailer\n<< /Root 1 0 R /Size 3 >>\nstartxref\n'+(position+root.length+pages.length)+'\n%%EOF\n');
  return Buffer.concat([head,comments,root,pages,xref]);
}
const file=(name,data,mediaType)=>({filename:name,mediaType,data});
const pdf=(size=2*MiB)=>file('Fictional-large.pdf',pdfAtLeast(size),'application/pdf');
const tiny=()=>file('Fictional-note.txt',Buffer.from('Fictional bytes\r\n'),'text/plain');
function frame(files,expectedRevision=1,options={}){
  const manifest=Buffer.from(JSON.stringify({version:1,expectedRevision,files:files.map(({filename,mediaType,data})=>({filename,mediaType,size:data.length})),...options}));
  const prefix=Buffer.alloc(4);
  prefix.writeUInt32BE(manifest.length);
  return Buffer.concat([prefix,manifest,...files.map(f=>f.data)]);
}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'trust-binary-batch-'));
  let sqliteFile=join(root,'state.sqlite'), server, origin;
  const codes=Object.fromEntries(Object.keys(roles).map(role=>[role,randomBytes(32).toString('base64url')]));
  const isolated={root:join(root,'workspaces'),
    workspaces:[{id:'alpha',label:'Fictional Alpha'},{id:'beta',label:'Fictional Beta'}],
    accounts:Object.entries(roles).map(([name,role])=>({id:'sample-'+name,codeHash:codeHash(codes[name]),memberships:{alpha:role,beta:role}})),
    attachmentReviewWorkspaces:['alpha','beta'],largePdfAttachmentWorkspaces:['alpha']};
  async function start(){
    server=createServer({sqliteFile,isolated}).listen(0,'127.0.0.1');
    await once(server,'listening');
    origin='http://127.0.0.1:'+server.address().port;
  }
  async function stop(){
    if(!server?.listening)return;
    server.closeAllConnections();await new Promise(r=>server.close(r));
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})});
  await start();
  const api=async(route,status,{cookie,body,scope='alpha',headers={}}={})=>{
    const url=new URL(route,origin);
    if(scope)url.searchParams.set('workspace',scope);
    const isBinary=Buffer.isBuffer(body);
    const res=await fetch(url,{method:body===undefined?'GET':'POST',headers:{
      ...(cookie?{cookie}:{}),...(body===undefined?{}:{origin,'content-type':isBinary?transport.contentType:'application/json'}),...headers},
      ...(body===undefined?{}:{body:isBinary?body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});
    const value=res.headers.get('content-type')==='application/octet-stream'?Buffer.from(await res.arrayBuffer()):await res.json();
    assert.equal(res.status,status,JSON.stringify(value));
    return {value,res};
  };
  const login=async(name,workspace='alpha')=>(await api('/api/session/login',200,{scope:null,body:{account:'sample-'+name,workspace,code:codes[name]}})).res.headers.get('set-cookie').split(';')[0];
  return {root,isolated,start,stop,api,login,codes,get origin(){return origin;},get sqliteFile(){return sqliteFile;},useSqlite:file=>{sqliteFile=file;}};
}
function attachmentPath(model){
  const d=model.documents[0],v=d.revisions[0];
  return base+'/records/'+d.id+'/revisions/'+v.id+'/attachments';
}

test('binary batch protocol rejects malformed, surplus, oversized, and ambiguous frames',()=>{
  const simple=tiny(), good=frame([simple],19);
  assert.deepEqual(transport.decode(good),{expectedRevision:19,files:[simple]});
  for(const broken of [Buffer.alloc(0),Buffer.from([0,0,1,0,4]),Buffer.alloc(7),good.subarray(0,-1),
    Buffer.concat([good,Buffer.from([0])]),frame([simple],1,{version:2}),frame([simple],1,{files:[{filename:'a.txt',mediaType:'text/plain',size:1,unexpected:1}]}),
    frame(Array(5).fill(simple)),frame([simple],-1),frame([simple],1,{files:[{filename:'missing.txt',mediaType:'text/plain',size:3*MiB}]})])
    assert.throws(()=>transport.decode(broken),{code:'ATTACHMENT_BATCH_FRAME'});
  assert.throws(()=>transport.decode(Buffer.alloc(transport.requestLimit+1)),{status:413});
  assert.throws(()=>transport.provision({largePdfAttachmentWorkspaces:['alpha']},null,new Set(['alpha'])),/require SQLite/);
  assert.throws(()=>transport.provision({largePdfAttachmentWorkspaces:['beta']},'mock.sqlite',new Set(['alpha'])),/manual quarantine/);
});

test('opt-in binary PDF upload is measured, atomic, scoped, quarantined and backup-restorable',async t=>{
  const f=await fixture(t);
  let author=await f.login('author'),reviewer=await f.login('reviewer');
  const operator=await f.login('operator'),other=await f.login('author','beta');
  const {value:created}=await f.api(base+'/records',200,{cookie:author,body:doc});
  assert.equal(created.attachmentRules.largePdfMaxBytes,4*MiB);
  assert.equal((await f.api(base,200,{cookie:reviewer})).value.attachmentRules.largePdfMaxBytes,undefined);
  assert.equal((await f.api(base,200,{cookie:other,scope:'beta'})).value.attachmentRules.largePdfMaxBytes,undefined);
  const root=attachmentPath(created),route=root+'/binary-batch',large=pdf(3*MiB),small=tiny();
  const data=frame([large,small],created.revision);
  await f.api(route,403,{cookie:reviewer,body:data});
  await f.api(route,403,{cookie:operator,body:data});
  await f.api(route,403,{cookie:other,body:data});
  await f.api(route,404,{cookie:other,scope:'beta',body:data});
  await f.api(route,415,{cookie:author,body:data,headers:{'content-encoding':'gzip'}});
  await f.api(route,403,{cookie:author,body:data,headers:{origin:'http://127.0.0.1:1'}});
  await f.api(base+'/records',415,{cookie:author,body:data});
  await f.api(route,413,{cookie:author,body:Buffer.alloc(transport.requestLimit+1)});
  await f.api(route,422,{cookie:author,body:data.subarray(0,-1)});
  await f.api(route,409,{cookie:author,body:frame([large],0)});
  await f.api(root+'/batch',413,{cookie:author,body:{files:[{...large,data:large.data.toString('base64')}],expectedRevision:created.revision}});
  const bad=await f.api(route,413,{cookie:author,body:frame([large,file('Fictional-too-large.txt',Buffer.alloc(18*1024,65),'text/plain')],created.revision)});
  assert.equal(bad.value.code,'ATTACHMENT_BATCH_INVALID');
  assert.equal(bad.value.fileErrors[0].index,1);
  let state=(await f.api(base,200,{cookie:author})).value;
  assert.equal(state.revision,created.revision);
  assert.deepEqual(state.documents[0].revisions[0].attachments,[]);
  const start=performance.now();
  state=(await f.api(route,200,{cookie:author,body:data})).value;
  const elapsed=performance.now()-start;
  assert.equal(state.revision,created.revision+1);
  const [big,smallRow]=state.documents[0].revisions[0].attachments;
  assert.deepEqual([big.reviewStatus,smallRow.reviewStatus],['pending','pending']);
  assert.equal(big.size,large.data.length);
  assert.equal(big.sha256,digest(large.data));
  let refused=await f.api(root+'/'+big.id+'/download',409,{cookie:reviewer,body:{}});
  assert.equal(refused.value.code,'ATTACHMENT_QUARANTINED');

  await f.stop();
  const backup=join(f.root,'safe-backup.json'),db=join(f.root,'restored.sqlite');
  backupDatabase(f.sqliteFile,backup);restoreDatabase(backup,db);f.useSqlite(db);
  delete f.isolated.largePdfAttachmentWorkspaces;
  delete f.isolated.attachmentReviewWorkspaces;
  await f.start();
  author=await f.login('author');reviewer=await f.login('reviewer');
  await f.api(route,404,{cookie:author,body:data});
  assert.equal((await f.api(base,200,{cookie:author})).value.attachmentRules.largePdfMaxBytes,undefined);
  refused=await f.api(root+'/'+big.id+'/download',409,{cookie:author,body:{}});
  assert.equal(refused.value.code,'ATTACHMENT_QUARANTINED');
  await f.api(root+'/'+big.id+'/review',200,{cookie:reviewer,body:{operation:'release',sha256:big.sha256,expectedRevision:state.revision}});
  const got=await f.api(root+'/'+big.id+'/download',200,{cookie:author,body:{}});
  assert.deepEqual(got.value,large.data);
  assert.equal(got.res.headers.get('content-type'),'application/octet-stream');
  assert.equal(got.res.headers.get('content-disposition'),'attachment; filename="Fictional-large.pdf"');
  assert.match(got.res.headers.get('content-security-policy'),/^sandbox/);
  const theoreticalJSON=Buffer.byteLength(JSON.stringify({expectedRevision:created.revision,files:[large,small].map(f=>({...f,data:f.data.toString('base64')}))}));
  t.diagnostic(JSON.stringify({largeFileBytes:large.data.length,rawRequestBytes:data.length,
    equivalentBase64JSONBytes:theoreticalJSON,uploadMs:Number(elapsed.toFixed(1))}));
});

test('Chromium attaches a larger PDF and small text together and downloads original bytes after separately approved release',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 and browser tools',timeout:30_000
},async t=>{
  const {chromium}=require('playwright'),f=await fixture(t);
  const author=await f.login('author');
  await f.api(base+'/records',200,{cookie:author,body:doc});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(9000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const signIn=async actor=>{
    await page.goto(f.origin);
    await page.getByLabel('Test account',{exact:true}).fill('sample-'+actor);
    await page.getByLabel('Workspace ID',{exact:true}).fill('alpha');
    await page.getByLabel('Local access code',{exact:true}).fill(f.codes[actor]);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
  };
  await signIn('author');
  await page.getByText(/4 MiB for PDF in this workspace/).waitFor();
  const files=[pdf(),tiny()];
  await page.getByLabel('Fictional attachments',{exact:true}).setInputFiles(files.map(f=>({name:f.filename,mimeType:f.mediaType,buffer:f.data})));
  const [request]=await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/binary-batch')),
    page.getByRole('button',{name:'Upload attachments',exact:true}).click()]);
  assert.equal(request.headers()['content-type'],transport.contentType);
  await page.getByText('Quarantined',{exact:true}).first().waitFor();
  assert.equal(await page.getByText('Quarantined',{exact:true}).count(),2);
  assert.equal(await page.getByRole('button',{name:'Download attachment Fictional-large.pdf',exact:true}).count(),0);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await signIn('reviewer');
  const row=page.locator('.document-attachments li').filter({hasText:'Fictional-large.pdf'});
  await row.getByText('Review attachment Fictional-large.pdf',{exact:true}).click();
  await row.getByLabel('Verified original SHA-256',{exact:true}).fill(digest(files[0].data));
  await row.getByRole('button',{name:'Release attachment',exact:true}).click();
  const action=page.getByRole('button',{name:'Download attachment Fictional-large.pdf',exact:true});
  const [download]=await Promise.all([page.waitForEvent('download'),action.click()]);
  const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks),files[0].data);
  assert.deepEqual(errors,[]);
});

test('the opted-in four MiB boundary accepts one exact PDF and rejects surplus bytes without committing',async t=>{
  const f=await fixture(t);
  const cookie=await f.login('author');
  const {value:created}=await f.api(base+'/records',200,{cookie,body:doc});
  const route=attachmentPath(created)+'/binary-batch';
  const overhead=pdf(4*MiB).data.length-4*MiB, full=pdf(4*MiB-overhead);
  assert.equal(full.data.length,4*MiB);
  await f.api(route,413,{cookie,body:frame([full,tiny()],created.revision)});
  const before=(await f.api(base,200,{cookie})).value;
  assert.equal(before.revision,created.revision);
  assert.deepEqual(before.documents[0].revisions[0].attachments,[]);
  const {value:done}=await f.api(route,200,{cookie,body:frame([full],created.revision)});
  assert.equal(done.documents[0].revisions[0].attachments[0].size,4*MiB);
  assert.equal(done.revision,created.revision+1);
});
