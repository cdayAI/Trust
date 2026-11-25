'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtemp,rm,readFile,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const http=require('node:http');
const {deflateRawSync,crc32}=require('node:zlib');
const sampleBytes=require('../fixtures/governance-upload-formats.json');
const {randomBytes,createHash}=require('node:crypto');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const attachmentPolicy=require('../governance-document-attachments');

const primary='alpha', secondary='beta';
const roles=[
  ['fictional-author',primary,'analyst'],['fictional-reviewer',primary,'reviewer'],
  ['fictional-operator',primary,'case-operator'],['fictional-other',secondary,'analyst']
];
async function fixture(t,backend){
  const root=await mkdtemp(join(tmpdir(),'mvw-attachment-'));
  const passwords=Object.fromEntries(roles.map(([id])=>[id,randomBytes(32).toString('base64url')]));
  const options={root,workspaces:[{id:primary,label:'Synthetic Alpha'},{id:secondary,label:'Synthetic Beta'}],
    accounts:roles.map(([id,workspace,role])=>({id,codeHash:codeHash(passwords[id]),memberships:{[workspace]:role}}))};
  let server,url;
  async function start(){
    server=createServer({isolated:options,...(backend==='sqlite'?{sqliteFile:join(root,'fictional.sqlite')}:{})}).listen(0,'127.0.0.1');
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
  assert.equal(created.attachmentRules.maxFileBytes,1024*1024);
  assert.equal(created.attachmentRules.formats.find(f=>f.extension==='.txt').maxFileBytes,16*1024);
  await post(uploads,payload,403,reviewer);
  await post(uploads,payload,403,reviewer,primary,{'X-Demo-Actor':'analyst'});
  await post(uploads,payload,401,null);
  await post(uploads,payload,403,other,primary);
  await post(uploads,{...payload,expectedRevision:0},404,other,secondary);
  await post(uploads,{...payload,expectedRevision:0},409);
  for(const invalid of [
    {...payload,filename:'../fictional.txt'},
    {...payload,filename:'CON.txt'},
    {...payload,filename:'fictional\r\n.txt'},
    {...payload,data:'not valid base64!'},
    {...payload,data:''}
  ])await post(uploads,invalid,422);
  for(const invalid of [
    {...payload,filename:'fictional.pdf'},
    {...payload,filename:'fictional.svg'},
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
  const cap={...payload,data:Buffer.alloc(16*1024,65).toString('base64')};
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
    const picker=analyst.getByLabel('Fictional attachments',{exact:true});
    const upload=analyst.getByRole('button',{name:'Upload attachments',exact:true});
    await picker.setInputFiles({name:'sample.svg',mimeType:'image/svg+xml',buffer:Buffer.from('Fictional unsupported file')});
    await upload.click();
    await analyst.getByText(/sample\.svg.*Choose a supported file format/).waitFor();
    await picker.setInputFiles({name:'large.txt',mimeType:'text/plain',buffer:Buffer.alloc(16*1024+1,65)});
    await upload.click();
    await analyst.getByText(/large\.txt.*up to 16 KiB/).waitFor();
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
    assert.equal(await reviewer.getByRole('button',{name:'Upload attachments',exact:true}).count(),0);
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

const mediaTypes={
  bmp:'image/bmp',csv:'text/csv',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif:'image/gif',jpg:'image/jpeg',jpeg:'image/jpeg',pdf:'application/pdf',png:'image/png',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',tif:'image/tiff',tiff:'image/tiff',
  tsv:'text/tab-separated-values',txt:'text/plain',webp:'image/webp',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const formatSamples=new Map(Object.entries(sampleBytes).map(([name,data])=>[name,Buffer.from(data,'base64')]));
formatSamples.set('fictional.jpg',formatSamples.get('fictional.jpeg'));
formatSamples.set('fictional.tif',formatSamples.get('fictional.tiff'));
const csvHeader=Buffer.from('record,amount,description\r\n');
const csvRow=Buffer.from('fictional,-12.75,"Quoted, with a ""mark""\nand a newline"\r\n');
formatSamples.set('fictional.csv',Buffer.from(csvHeader.toString()+csvRow.toString().repeat(750))); // safely crosses generic 32 KiB limit
formatSamples.set('fictional.tsv',Buffer.from('record\tamount\r\nfictional\t-12.75\r\n'));
formatSamples.set('fictional.txt',Buffer.from(original));
function formatPayload(filename,bytes,mediaType=mediaTypes[filename.split('.').at(-1)]??''){
  return {filename,mediaType,data:bytes.toString('base64')};
}

test('attachment allowlist accepts real byte structures by extension with known or empty browser media types',()=>{
  const version={attachments:[]},book={documents:[{revisions:[version]}]};
  for(const [name,bytes] of formatSamples){
    for(const reported of [undefined,'']){
      const dest=attachmentPolicy.attachment(formatPayload(name,bytes,reported),book,version);
      assert.equal(dest.mediaType,mediaTypes[name.split('.').at(-1)]);
      assert.equal(dest.size,bytes.length);
      assert.deepEqual(attachmentPolicy.download(dest),{filename:name,bytes});
    }
    const corrupted=Buffer.from(bytes);
    corrupted[0]=0;
    assert.throws(()=>attachmentPolicy.attachment(formatPayload(name,corrupted),book,version),{status:415});
  }
  const boundary=Buffer.alloc(1024*1024,65);
  assert.equal(attachmentPolicy.attachment(formatPayload('limit.csv',boundary,'application/vnd.ms-excel'),book,version).size,boundary.length);
  assert.throws(()=>attachmentPolicy.attachment(formatPayload('limit.csv',Buffer.concat([boundary,Buffer.from('a')])),book,version),{status:413});
});

function zip(rows,options={}){
  const local=[],central=[];
  let offset=0,centralSize=0;
  for(const [name,data] of rows){
    const entry=Buffer.from(name),payload=Buffer.from(data),method=options.stored?0:8;
    const compressed=method?deflateRawSync(payload):payload,length=options.claim?.[name]??payload.length,crc=crc32(payload);
    const desc=options.descriptor?Buffer.alloc(16):Buffer.alloc(0);
    if(desc.length){desc.writeUInt32LE(0x08074b50);desc.writeUInt32LE(crc,4);desc.writeUInt32LE(compressed.length,8);desc.writeUInt32LE(length,12);}
    const flags=(options.flags??0)|(desc.length?8:0);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20,4);
    header.writeUInt16LE(flags,6);
    header.writeUInt16LE(method,8);
    if(!desc.length){
      header.writeUInt32LE(crc,14);
      header.writeUInt32LE(compressed.length,18);
      header.writeUInt32LE(length,22);
    }
    header.writeUInt16LE(entry.length,26);
    const item=Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50);
    item.writeUInt16LE(20,4);
    item.writeUInt16LE(20,6);
    item.writeUInt16LE(flags,8);
    item.writeUInt16LE(method,10);
    item.writeUInt32LE(crc,16);
    item.writeUInt32LE(compressed.length,20);
    item.writeUInt32LE(length,24);
    item.writeUInt16LE(entry.length,28);
    item.writeUInt32LE(offset,42);
    offset+=header.length+entry.length+compressed.length+desc.length;centralSize+=item.length+entry.length;
    local.push(header,entry,compressed,desc);central.push(item,entry);
  }
  const trailer=Buffer.alloc(22);
  trailer.writeUInt32LE(0x06054b50);
  trailer.writeUInt16LE(rows.length,8);
  trailer.writeUInt16LE(rows.length,10);
  trailer.writeUInt32LE(centralSize,12);
  trailer.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,trailer]);
}
const wordMain='word/document.xml',typesName='[Content_Types].xml',rootRels='_rels/.rels';
const baseTypes='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const officeRel='<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>';
const relDoc=rows=>'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rows+'</Relationships>';
const wordDocument='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>';
const wordRows=[[typesName,baseTypes],[rootRels,relDoc(officeRel)],[wordMain,wordDocument]];
const changePart=(name,value)=>wordRows.map(([part,data])=>[part,part===name?value:data]);

test('strict Office package inspection rejects unsupported active components, shape mismatches, and excess structure',()=>{
  const v={attachments:[]},book={documents:[{revisions:[v]}]};
  function save(bytes,filename='fictional.docx'){return attachmentPolicy.attachment(formatPayload(filename,bytes),book,v);}
  assert.equal(save(zip(wordRows,{stored:true})).mediaType,mediaTypes.docx);
  assert.equal(save(zip(wordRows,{descriptor:true})).mediaType,mediaTypes.docx);
  const bad=[
    zip([['fictional.txt','Only an ordinary archive.']]),
    zip(wordRows,{flags:1}),
    zip([...wordRows,['word/../discard.xml','<discard/>']]),
    zip([...wordRows,['word/DOCUMENT.xml','<duplicate/>']]),
    zip([...wordRows,['word/embeddings/example.bin','fictional inactive bytes']]),
    zip([...wordRows,['word/vbaProject.bin','fictional inactive bytes']]),
    zip(changePart(typesName,baseTypes.replace('document.main+xml','document.macroEnabled.main+xml'))),
    zip(changePart(rootRels,relDoc(officeRel.replace('/>',' TargetMode="External"/>')))),
    zip(changePart(rootRels,relDoc(officeRel.replace('word/document.xml','missing.xml')))),
    zip(changePart(rootRels,relDoc(officeRel)+'<Other/>')),
    zip(changePart(wordMain,'<!DOCTYPE fictional>'+wordDocument)),
    zip(changePart(wordMain,wordDocument.replace('<w:p/>','<w:altChunk/>'))),
    zip([...wordRows,['word/extra.xml','<data>'+('x'.repeat(2*1024*1024))+'</data>']]),
    zip([...wordRows,...Array.from({length:256},(_,i)=>['word/p-'+i+'.xml','<part/>'])]),
    zip(wordRows,{claim:{[wordMain]:10}}),
    Buffer.concat([zip(wordRows),Buffer.from('trailing ordinary text')])
  ];
  for(const [index,bytes] of bad.entries())assert.throws(()=>save(bytes),{status:415},'sample '+index);
  assert.throws(()=>save(formatSamples.get('fictional.xlsx')),{status:415});
  assert.throws(()=>save(Buffer.from('Only fictional plain text.'),'fictional.pdf'),{status:415});
  assert.throws(()=>save(Buffer.from('<svg></svg>'),'fictional.svg'),{code:'ATTACHMENT_TYPE_UNSUPPORTED'});
  for(const name of ['fictional.exe','fictional.js','fictional.zip','fictional.docm','fictional.xlsm','fictional.pptm','fictional.doc','fictional.xls','fictional.ppt','fictional.rtf'])
    assert.throws(()=>save(Buffer.from('Fictional placeholder.'),name),{code:'ATTACHMENT_TYPE_UNSUPPORTED'});
  for(const [name,content] of [['fictional.csv','name,value\r\nfictional,"=1+1"'],['fictional.tsv','fictional\t  +1+1'],['fictional.csv','fictional,"unterminated']]){
    assert.throws(()=>save(Buffer.from(content),name),{status:415});
  }
});

test('extended request limit is scoped to the authorized upload path for content-length and chunked POSTs',async t=>{
  const f=await fixture(t),cookie=await f.login(roles[0]),reviewer=await f.login(roles[1]);
  const documents=collection+'?workspace=alpha',create=collection+'/records?workspace=alpha';
  const {data:state}=await f.request(create,200,{cookie,body:{expectedRevision:0,...doc}});
  const d=state.documents[0],v=d.revisions[0],path=collection+'/records/'+d.id+'/revisions/'+v.id+'/attachments?workspace=alpha';
  const sample=formatSamples.get('fictional.csv'),body={...formatPayload('fictional.csv',sample),expectedRevision:state.revision};
  assert.ok(sample.length>32768);
  await f.request(create,413,{cookie,body});
  await f.request(path,403,{cookie:reviewer,body});
  const {data:success}=await f.request(path,200,{cookie,body});
  assert.equal(success.documents[0].revisions[0].attachments[0].size,sample.length);
  const huge='A'.repeat(attachmentPolicy.uploadRequestBytes+1);
  await f.request(path,413,{cookie,body:{...body,data:huge}});
  const chunked=await new Promise((resolve,reject)=>{
    const req=http.request(f.url+'/api/'+path,{method:'POST',headers:{Cookie:cookie,Origin:f.url,'Content-Type':'application/json'}},res=>{
      const data=[];res.on('data',b=>data.push(b));res.on('end',()=>resolve({status:res.statusCode,data:Buffer.concat(data).toString()}));
    });
    req.on('error',reject);
    for(let at=0;at<huge.length;at+=8192)req.write(huge.slice(at,at+8192));
    req.end();
  });
  assert.equal(chunked.status,413);
  assert.match(chunked.data,/encoded upload limit/);
  assert.equal((await f.request(documents,200,{cookie})).data.documents[0].revisions[0].attachments.length,1);
});

test('browser: each allowed format uploads with the real chooser and downloads byte-for-byte without rendering',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:50_000
},async t=>{
  const {chromium}=require('playwright'),f=await fixture(t);
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage(),pageErrors=[],external=[];
  page.setDefaultTimeout(6500);
  page.on('pageerror',e=>pageErrors.push(e.message));
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).origin===f.url)return route.continue();
    external.push(route.request().url());return route.abort();
  });
  await page.goto(f.url);
  await page.getByLabel('Test account',{exact:true}).fill(roles[0][0]);
  await page.getByLabel('Workspace ID',{exact:true}).fill(primary);
  await page.getByLabel('Local access code',{exact:true}).fill(f.passwords[roles[0][0]]);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
  const samples=Array.from(formatSamples),groupSize=4;
  for(let offset=0;offset<samples.length;offset+=groupSize){
    const title='Fictional format roundtrip '+offset, draft=page.locator('details').filter({has:page.locator('summary').getByText('Draft a document',{exact:true})});
    await draft.locator('summary').click();
    await draft.getByLabel('Fictional title',{exact:true}).fill(title);
    await draft.getByLabel('Original fictional text',{exact:true}).fill(doc.content);
    await draft.getByRole('button',{name:'Create document draft',exact:true}).click();
    const card=page.locator('article section').filter({has:page.getByRole('heading',{name:title,exact:true})});
    const selected=samples.slice(offset,offset+groupSize),paths=[];
    for(const [name,bytes] of selected){
      const temp=join(f.root,name);
      await writeFile(temp,bytes);paths.push(temp);
    }
    const picker=card.getByLabel('Fictional attachments',{exact:true});
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),picker.click()]);
    assert.equal(chooser.isMultiple(),true);
    await chooser.setFiles(paths);
    await card.getByText(new RegExp('^'+selected.length+' selected')).waitFor();
    await card.getByRole('button',{name:'Upload attachments',exact:true}).click();
    for(const [name,bytes] of selected){
      const action=card.getByRole('button',{name:'Download attachment '+name,exact:true});
      const [download]=await Promise.all([page.waitForEvent('download'),action.click()]);
      assert.equal(download.suggestedFilename(),name);
      const chunks=[];
      for await(const chunk of await download.createReadStream())chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks),bytes,name);
    }
    assert.equal(await card.locator('.document-attachments img, .document-attachments iframe, .document-attachments embed').count(),0);
  }
  assert.deepEqual(pageErrors,[]);assert.deepEqual(external,[]);
});

for(const backend of ['json','sqlite'])test('batch upload is atomic, role-scoped, audited and durable with '+backend,async t=>{
  const f=await fixture(t,backend);
  let author=await f.login(roles[0]),reviewer=await f.login(roles[1]);
  const operator=await f.login(roles[2]),other=await f.login(roles[3]);
  const scoped=(path,scope=primary)=>collection+path+'?workspace='+scope;
  const create=()=>f.request(scoped('/records'),200,{cookie:author,body:{...doc,expectedRevision:0}});
  const {data:draft}=await create();
  const d=draft.documents[0],v=d.revisions[0],base='/records/'+d.id+'/revisions/'+v.id+'/attachments';
  const route=scoped(base+'/batch');
  const samples=['fictional.docx','fictional.pdf','fictional.png','fictional.csv'].map(name=>formatPayload(name,formatSamples.get(name)));
  const batch=(files,expectedRevision=draft.revision)=>({files,expectedRevision});
  const view=async(c=author)=>(await f.request(scoped(''),200,{cookie:c})).data;
  assert.equal(draft.attachmentRules.maxFilesPerBatch,4);
  assert.equal(draft.attachmentRules.maxBatchBytes,4*1024*1024);
  for(const [cookie,status] of [[null,401],[reviewer,403],[operator,403],[other,403]])
    await f.request(route,status,{cookie,body:batch(samples)});
  await f.request(scoped(base+'/batch',secondary),404,{cookie:other,body:batch(samples,0)});
  await f.request(route,409,{cookie:author,body:batch(samples,0)});
  for(const files of [[],{not:'an array'},Array.from({length:5},()=>samples[0])]){
    const bad=await f.request(route,422,{cookie:author,body:batch(files)});
    assert.equal(bad.data.code,'ATTACHMENT_BATCH_COUNT');
  }
  const bad=await f.request(route,415,{cookie:author,body:batch([samples[0],
    formatPayload('fictional-invalid.pdf',Buffer.from('synthetic non-PDF')),
    samples[1],formatPayload('fictional-invalid.svg',Buffer.from('synthetic unsupported'))])});
  assert.equal(bad.data.code,'ATTACHMENT_BATCH_INVALID');
  assert.deepEqual(bad.data.fileErrors.map(({index,code})=>[index,code]),[
    [1,'ATTACHMENT_CONTENT_INVALID'],[3,'ATTACHMENT_TYPE_UNSUPPORTED']
  ]);
  assert.equal((await view()).revision,draft.revision);
  assert.deepEqual((await view()).documents[0].revisions[0].attachments,[]);
  assert.doesNotMatch(JSON.stringify(bad.data),/fictional-invalid|synthetic non-PDF/);
  const before=(await f.request('audit/export?workspace=alpha',200,{cookie:reviewer})).data.audit;
  assert.equal(before.filter(x=>x.action===collection+'.attachment-upload').length,0);
  const {data:success}=await f.request(route,200,{cookie:author,body:batch(samples)});
  assert.equal(success.revision,draft.revision+1);
  assert.deepEqual(success.documents[0].revisions[0].attachments.map(x=>x.name),samples.map(x=>x.filename));
  assert.equal((await f.request(route,409,{cookie:author,body:batch(samples,success.revision)})).data.code,'ATTACHMENT_REVISION_LIMIT');
  const after=(await f.request('audit/export?workspace=alpha',200,{cookie:reviewer})).data.audit;
  const writes=after.filter(x=>x.action===collection+'.attachment-upload');
  assert.equal(writes.length,4);
  assert.ok(writes.every(x=>x.details.revision===success.revision&&x.account===roles[0][0]));
  assert.ok(samples.every(x=>!JSON.stringify(writes).includes(x.filename)));
  await f.stop();await f.start();
  author=await f.login(roles[0]);reviewer=await f.login(roles[1]);
  const persisted=(await view()).documents[0].revisions[0].attachments;
  for(const row of persisted){
    const {data,response}=await f.request(scoped(base+'/'+row.id+'/download'),200,{cookie:reviewer,body:{}});
    assert.deepEqual(data,formatSamples.get(row.name));
    assert.equal(response.headers.get('content-disposition'),'attachment; filename="'+row.name+'"');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
});

test('batch body and workspace budgets accept four exact 1 MiB files but never partially save a rejected batch',async t=>{
  const f=await fixture(t);
  const author=await f.login(roles[0]);
  const files=Array.from({length:4},(_,i)=>formatPayload('synthetic-'+i+'.csv',Buffer.alloc(1024*1024,65)));
  let revision=0;
  async function draft(i){
    const {data}=await f.request(collection+'/records?workspace=alpha',200,{cookie:author,body:{...doc,title:'Fictional limit '+i,expectedRevision:revision}});
    revision=data.revision;
    const d=data.documents.find(row=>row.revisions[0].title==='Fictional limit '+i);
    return collection+'/records/'+d.id+'/revisions/'+d.revisions[0].id+'/attachments/batch?workspace=alpha';
  }
  const first=await draft(1);
  const tooBig=attachmentPolicy.batchUploadRequestBytes+1;
  const body={files:[{...files[0],data:'A'.repeat(tooBig)}],expectedRevision:revision};
  assert.equal((await f.request(first,413,{cookie:author,body})).response.headers.get('connection'),'close');
  for(let i=1;i<=2;i++){
    const dest=i===1?first:await draft(2);
    const {data}=await f.request(dest,200,{cookie:author,body:{files,expectedRevision:revision}});
    revision=data.revision;
  }
  const third=await draft(3);
  const refusal=(await f.request(third,409,{cookie:author,body:{files:[files[0]],expectedRevision:revision}})).data;
  assert.equal(refusal.code,'ATTACHMENT_WORKSPACE_LIMIT');
  const {data}=await f.request(collection+'?workspace=alpha',200,{cookie:author});
  assert.equal(data.revision,revision);
  assert.equal(data.documents.reduce((n,d)=>n+d.revisions[0].attachments.length,0),8);
  assert.deepEqual(data.documents.find(d=>d.revisions[0].title==='Fictional limit 3').revisions[0].attachments,[]);
});

test('Chromium drops multiple files and shows content refusals individually without saving any',{
  skip:process.env.RUN_BROWSER_SMOKE!=='1'&&'Set RUN_BROWSER_SMOKE=1 with Playwright installed',timeout:30000
},async t=>{
  const {chromium}=require('playwright'),f=await fixture(t);
  const cookie=await f.login(roles[0]);
  await f.request(collection+'/records?workspace=alpha',200,{cookie,body:{...doc,expectedRevision:0}});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(7500);
  await page.goto(f.url);
  await page.getByLabel('Test account',{exact:true}).fill(roles[0][0]);
  await page.getByLabel('Workspace ID',{exact:true}).fill(primary);
  await page.getByLabel('Local access code',{exact:true}).fill(f.passwords[roles[0][0]]);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Policies and documents',exact:true}).click();
  const drop=page.locator('.attachment-drop-zone');
  async function dropFiles(files){
    const handle=await page.evaluateHandle(input=>{
      const transfer=new DataTransfer();
      for(const file of input)transfer.items.add(new File([Uint8Array.from(file.bytes)],file.name,{type:file.type}));
      return transfer;
    },files);
    await drop.dispatchEvent('dragover',{dataTransfer:handle});
    await drop.dispatchEvent('drop',{dataTransfer:handle});
    await handle.dispose();
  }
  const good={name:'Fictional drop.txt',type:'text/plain',bytes:[...Buffer.from(original)]};
  await dropFiles([good,{name:'Fictional bad.pdf',type:'application/pdf',bytes:[...Buffer.from('Fictional bad PDF')]}]);
  await page.getByText(/^2 selected/).waitFor();
  const button=page.getByRole('button',{name:'Upload attachments',exact:true});
  await button.click();
  await page.getByText(/Fictional bad\.pdf.*file bytes do not match/).waitFor();
  await page.getByText('No attachments.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Download attachment Fictional drop.txt',exact:true}).count(),0);
  await page.getByRole('button',{name:'Remove selected file Fictional bad.pdf',exact:true}).click();
  await button.click();
  await page.getByRole('button',{name:'Download attachment Fictional drop.txt',exact:true}).waitFor();
});
