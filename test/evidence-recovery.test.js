'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {mkdtemp,writeFile,readFile,access,rm,readdir,mkdir}=require('node:fs/promises');
const {once}=require('node:events');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {spawnSync}=require('node:child_process');
const docs=require('../governance-documents');
const attachmentPolicy=require('../governance-document-attachments');
const {openSqlite,backupDatabase,verifyBackup,restoreDatabase,migrateIsolated}=require('../durable-storage');
const {createServer}=require('../server');
const {codeHash}=require('../workspace-access');
const hash=value=>createHash('sha256').update(value).digest('hex');
const source=join(__dirname,'..');
const reporter='sample-reviewer',uploader='sample-author';
const path='/api/governance-documents';
const initialText='Original fictional edition text.';
const fileBytes=Buffer.from('Original fictional evidence.\r\n');
const notFound={code:'ENOENT'};

function createEvidence(){
  const caseId=randomUUID();
  const state={version:1,actors:[{id:'analyst'},{id:'reviewer'},{id:'case-operator'}],projects:[],vendors:[],assessments:[],handoff:[],audit:[],
    rightsCases:[{id:caseId,kind:'access',owner:'case-operator'}]};
  docs.enableManualReview(state);
  const record=(state,actor,action,projectId,entityId,details)=>state.audit.push({
    id:randomUUID(),sequence:state.audit.length+1,at:'2026-01-10T00:00:00.000Z',actor,action,projectId,entityId,details
  });
  const mutate=(suffix,body={},actor='analyst')=>docs.change(state,['governance-documents',...suffix],
    actor,{expectedRevision:state.governanceDocuments.revision,...body},record,undefined,actor==='analyst'?uploader:reporter);
  mutate(['records'],{title:'Fictional linked evidence',kind:'evidence',content:initialText,links:[{type:'rights-case',id:caseId}]});
  const doc=state.governanceDocuments.documents[0],v=doc.revisions[0],r=['records',doc.id,'revisions',v.id];
  mutate([...r,'attachments'],{filename:'Fictional-note.txt',mediaType:'text/plain',data:fileBytes.toString('base64')});
  const first=v.attachments[0];
  mutate([...r,'attachments',first.id,'review'],{operation:'release',sha256:first.sha256},'reviewer');
  mutate([...r,'submit']);
  mutate([...r,'publish'],{note:'Fictional independent publication.'},'reviewer');
  mutate(['records',doc.id,'revise'],{title:'Fictional pending evidence',content:'A different fictional text.',links:[{type:'rights-case',id:caseId}]});
  mutate(['records',doc.id,'revisions',doc.revisions[1].id,'attachments'],{
    filename:'Fictional-pending.txt',mediaType:'text/plain',data:Buffer.from('Still quarantined.').toString('base64')
  });
  return state;
}

function createDb(file,state){
  const db=openSqlite(file);
  try{
    db.requireMode('isolated');
    db.import('isolated',[{kind:'workbench',scope:'workspace:sample',generation:1,payload:state}]);
  }finally{db.close();}
}
function changed(file,operation){
  const db=openSqlite(file);
  try{db.scope('workspace:sample').write('workbench',(snapshot,save)=>{operation(snapshot.governanceDocuments,snapshot);save(snapshot);});}
  finally{db.close();}
}
async function temp(t){
  const dir=await mkdtemp(join(tmpdir(),'trust-evidence-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
function envelope(state){
  const unsigned={format:'mvw-trust-local-backup',version:1,mode:'isolated',
    documents:[{kind:'workbench',scope:'workspace:sample',generation:1,payload:state}]};
  return {...unsigned,sha256:hash(JSON.stringify(unsigned))};
}

test('verified backup preserves released and pending evidence by exact edition, hashes, and typed link',async t=>{
  const dir=await temp(t),state=createEvidence();
  const db=join(dir,'working.sqlite'),backup=join(dir,'evidence.json'),restored=join(dir,'restored.sqlite');
  createDb(db,state);
  const book=state.governanceDocuments;
  assert.equal(backupDatabase(db,backup).documents,1);
  const verified=verifyBackup(backup);
  assert.deepEqual(verified.documents[0].payload.governanceDocuments,book);
  restoreDatabase(backup,restored);
  const reopened=openSqlite(restored,{readOnly:true});
  try{
    const snapshot=reopened.snapshot().documents[0].payload;
    assert.deepEqual(snapshot.governanceDocuments,book);
    const result=docs.view(snapshot,'reviewer').documents[0];
    assert.deepEqual(result.revisions.flatMap(v=>v.attachments.map(f=>f.reviewStatus)),['released','pending']);
    assert.equal(result.revisions[0].links[0].id,state.rightsCases[0].id);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(fileBytes.toString('base64')));
  }finally{reopened.close();}
});

test('outer checksums cannot bless inconsistent evidence, release state, attachment identity or typed linkage',async t=>{
  const dir=await temp(t), good=createEvidence();
  const variants=[
    ['edition text',book=>book.documents[0].revisions[0].content='Changed synthetic evidence'],
    ['edition text',book=>book.documents[0].revisions[0].contentLength+=1],
    ['typed links',book=>book.documents[0].revisions[0].links[0].type='risk'],
    ['typed links',book=>book.documents[0].revisions[0].links[0].id=randomUUID()],
    ['attachment bytes',book=>book.documents[0].revisions[0].attachments[0].data=Buffer.from('Different synthetic evidence').toString('base64')],
    ['attachment metadata',book=>book.documents[0].revisions[1].attachments[0].id=book.documents[0].revisions[0].attachments[0].id],
    ['attachment quarantine',book=>{delete book.attachmentReview;}],
    ['attachment quarantine',book=>{const row=book.documents[0].revisions[0].attachments[0];row.quarantine={status:'pending',uploader};}],
    ['attachment quarantine',book=>book.documents[0].revisions[0].attachments[0].quarantine.decidedBy=uploader]
  ];
  for(const [index,[label,mutate]] of variants.entries()){
    const altered=structuredClone(good);
    mutate(altered.governanceDocuments);
    const file=join(dir,'bad-'+index+'.json'),target=join(dir,'missing-'+index+'.sqlite');
    await writeFile(file,JSON.stringify(envelope(altered)),{mode:0o600});
    const refused=new RegExp('Governance evidence integrity check failed \\('+label+'\\)');
    assert.throws(()=>verifyBackup(file),refused,'verify '+index);
    assert.throws(()=>restoreDatabase(file,target),refused,'restore '+index);
    await assert.rejects(access(target),notFound);
  }
  assert.ok((await readdir(dir)).every(name=>name.endsWith('.json')));
});

test('backup and JSON migration refuse inconsistent source data without modifying source or publishing output',async t=>{
  const dir=await temp(t),good=createEvidence();
  const db=join(dir,'working.sqlite'),backup=join(dir,'bad.trust-backup.json'),target=join(dir,'migration.sqlite');
  createDb(db,good);
  changed(db,book=>book.documents[0].revisions[0].content='Altered synthetic source.');
  const before=await readFile(db);
  const command=spawnSync(process.execPath,['storage-cli.js','backup',db,backup],{cwd:source,encoding:'utf8',timeout:5000});
  assert.equal(command.status,1,command.stderr);
  assert.match(command.stderr,/Governance evidence integrity check failed \(edition text\)/);
  assert.doesNotMatch(command.stderr,/Altered synthetic source|Fictional-note/);
  assert.deepEqual(await readFile(db),before);
  await assert.rejects(access(backup),notFound);
  const isolated=join(dir,'workspaces'),workspace=join(isolated,'sample');
  await mkdir(workspace,{recursive:true});
  const json=join(workspace,'state.json');
  const damaged=structuredClone(good);
  damaged.governanceDocuments.documents[0].revisions[0].links[0].id=randomUUID();
  const bytes=JSON.stringify(damaged);
  await writeFile(json,bytes,{mode:0o600});
  assert.throws(()=>migrateIsolated(isolated,target),/Governance evidence integrity check failed \(typed links\)/);
  await assert.rejects(access(target),notFound);
  assert.equal(await readFile(json,'utf8'),bytes);
});

test('HTTP refuses altered text and does not publish inconsistent attachment bytes under a recorded hash',async t=>{
  const dir=await temp(t),state=createEvidence(),file=join(dir,'live.sqlite');
  const book=state.governanceDocuments,doc=book.documents[0],published=doc.revisions[0],draft=doc.revisions[1];
  const draftAttachment=draft.attachments[0];
  draftAttachment.quarantine={status:'released',uploader,decidedBy:reporter,approvedHash:draftAttachment.sha256};
  createDb(file,state);
  const codes={[uploader]:randomBytes(32).toString('base64url'),[reporter]:randomBytes(32).toString('base64url')};
  const server=createServer({sqliteFile:file,isolated:{
    root:join(dir,'workspaces'),workspaces:[{id:'sample',label:'Fictional workspace'}],
    accounts:[[uploader,'analyst'],[reporter,'reviewer']].map(([id,role])=>({id,codeHash:codeHash(codes[id]),memberships:{sample:role}}))
  }}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port;
  async function post(route,status,body,cookie){
    const url=new URL(route,origin);
    if(cookie)url.searchParams.set('workspace','sample');
    const res=await fetch(url,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},
      body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return {data,res};
  }
  const login=async account=>(await post('/api/session/login',200,{account,workspace:'sample',code:codes[account]})).res.headers.get('set-cookie').split(';')[0];
  const analyst=await login(uploader),reviewer=await login(reporter);
  changed(file,stored=>{
    stored.documents[0].revisions[0].content='Altered synthetic text that must not be returned.';
    stored.documents[0].revisions[1].attachments[0].data=Buffer.from('Changed synthetic attachment').toString('base64');
  });
  for(const c of [analyst,reviewer])for(const verb of ['read','download']){
    const {data}=await post(path+'/records/'+doc.id+'/revisions/'+published.id+'/'+verb,409,{},c);
    assert.equal(data.code,'EDITION_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(data),/must not be returned/);
  }
  const {data}=await post(path+'/records/'+doc.id+'/revisions/'+draft.id+'/submit',409,{expectedRevision:book.revision},analyst);
  assert.equal(data.code,'ATTACHMENT_UNAVAILABLE');
  changed(file,stored=>{
    stored.documents[0].revisions[1].attachments[0].data=draftAttachment.data;
    stored.documents[0].revisions[1].links[0].type='risk';
  });
  const link=await post(path+'/records/'+doc.id+'/revisions/'+draft.id+'/submit',422,{expectedRevision:book.revision},analyst);
  assert.equal(link.data.code,'INVALID_LINK');
  const db=openSqlite(file,{readOnly:true});
  try{
    const final=db.scope('workspace:sample').read('workbench');
    assert.equal(final.governanceDocuments.revision,book.revision);
    assert.equal(final.governanceDocuments.documents[0].revisions[1].status,'draft');
    assert.ok(final.audit.some(event=>event.action==='governance-documents.refused'&&event.details.code==='ATTACHMENT_UNAVAILABLE'));
  }finally{db.close();}
});

test('an extended-size attachment without its persisted review cannot become an ordinary legacy file',()=>{
  const attachment={payloadProfile:'large-pdf-v1'};
  for(const workspacePolicy of [true,false]){
    assert.throws(()=>attachmentPolicy.assertAvailable(attachment,workspacePolicy),{code:'ATTACHMENT_QUARANTINED'});
    assert.throws(()=>attachmentPolicy.verifyStored(attachment,workspacePolicy,{draft:true}),{code:'ATTACHMENT_QUARANTINED'});
  }
});
