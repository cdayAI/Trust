'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm,access,chmod,link,symlink,readFile,readdir,stat,truncate,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {spawnSync}=require('node:child_process');
const {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID}=require('node:crypto');
const {openSqlite,verifyBackup}=require('../durable-storage');
const docs=require('../governance-documents');

const supported=typeof process.geteuid==='function'&&require('node:fs').constants.O_NOFOLLOW!==undefined;
const opts={skip:!supported&&'Needs POSIX owner/mode checks',timeout:25000};
const fixtureText='Fictional unreleased storage evidence, never displayed in command output.';
const keyFailure=/private, owner-only, single-link key file containing exactly 32 raw bytes/;
const envelopeFailure=/encrypted backup (?:envelope|file)/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
const root=join(__dirname,'..');
const summary={mode:'isolated',documents:3,encryption:'aes-256-gcm',version:1};

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'trust-encrypted-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const paths=Object.fromEntries(['database.sqlite','primary.key','different.key','encrypted.workbench'].map(name=>[name.split('.')[0],join(dir,name)]));
  const primary=randomBytes(32),different=randomBytes(32);
  await writeFile(paths.primary,primary,{mode:0o600});
  await writeFile(paths.different,different,{mode:0o400});
  const state={version:1,actors:[{id:'analyst'},{id:'reviewer'},{id:'case-operator'}],
    projects:Array.from({length:200},(_,i)=>({id:'fictional-'+i,name:'Fictional fixture '+i,description:'x'.repeat(700)})),
    vendors:[],assessments:[],handoff:[],audit:[]};
  docs.enableManualReview(state);
  const event=(s,actor,action,projectId,entityId,details)=>s.audit.push({
    id:randomUUID(),sequence:s.audit.length+1,actor,action,projectId,entityId,details,at:'2026-01-01T00:00:00.000Z'
  });
  docs.change(state,['governance-documents','records'],'analyst',{expectedRevision:0,kind:'policy',
    title:'Fictional quarantined fixture',content:fixtureText,links:[]},event,undefined,'sample-author');
  const d=state.governanceDocuments.documents[0],v=d.revisions[0];
  docs.change(state,['governance-documents','records',d.id,'revisions',v.id,'attachments'],'analyst',{
    filename:'synthetic-evidence.txt',mediaType:'text/plain',data:Buffer.from(fixtureText).toString('base64'),
    expectedRevision:1
  },event,undefined,'sample-author');
  const database=openSqlite(paths.database);
  try{
    database.requireMode('isolated');
    database.import('isolated',[
      {scope:'workspace:alpha',kind:'workbench',generation:4,payload:state},
      {scope:'workspace:alpha',kind:'workflow',generation:2,payload:{schemaVersion:1,definitions:[],instances:[],events:[]}},
      {scope:'workspace:beta',kind:'workbench',generation:1,payload:{...state,projects:[],governanceDocuments:{revision:0,documents:[]},audit:[]}}
    ]);
  }finally{database.close();}
  return {dir,paths,keys:{primary,different},state};
}
function cli(args,status=0){
  const result=spawnSync(process.execPath,['storage-cli.js',...args],{cwd:root,encoding:'utf8',timeout:12000});
  assert.equal(result.status,status,result.stderr||result.error?.message);
  assert.doesNotMatch(result.stdout+result.stderr,new RegExp(fixtureText));
  return status?result.stderr:JSON.parse(result.stdout);
}
function openStandard(archive,key){
  assert.equal(archive.subarray(0,8).toString('ascii'),'MVWTRSTE');
  assert.equal(archive[8],1);
  assert.equal(archive[9],1);
  const header=archive.subarray(0,26),length=header.readUInt32BE(22);
  assert.equal(archive.length,26+length+16);
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(10,22),{authTagLength:16});
  decipher.setAAD(header,{plaintextLength:length});
  decipher.setAuthTag(archive.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(archive.subarray(26,-16)),decipher.final()]).toString('utf8'));
}
function sealStandard(content,key){
  const bytes=Buffer.from(JSON.stringify(content),'utf8'), header=Buffer.alloc(26);
  header.write('MVWTRSTE');header[8]=1;header[9]=1;
  randomBytes(12).copy(header,10);header.writeUInt32BE(bytes.length,22);
  const cipher=createCipheriv('aes-256-gcm',key,header.subarray(10,22),{authTagLength:16});
  cipher.setAAD(header,{plaintextLength:bytes.length});
  return Buffer.concat([header,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
}
const changed=(buffer,at)=>{const copy=Buffer.from(buffer);copy[at]^=1;return copy;};

test('offline encrypted CLI roundtrip preserves exact scope, generations, and quarantined evidence, with fresh nonces and plain compatibility',opts,async t=>{
  const {dir,paths,keys,state}=await fixture(t);
  const one=paths.encrypted,two=join(dir,'second.workbench'),plain=join(dir,'plain.json'),restored=join(dir,'restored.sqlite');
  assert.deepEqual(cli(['backup-encrypted',paths.database,one,paths.primary]),summary);
  assert.deepEqual(cli(['backup-encrypted',paths.database,two,paths.primary]),summary);
  assert.deepEqual(cli(['verify-encrypted',one,paths.primary]),summary);
  assert.deepEqual(cli(['restore-encrypted',one,restored,paths.primary]),summary);
  const a=await readFile(one),b=await readFile(two);
  assert.notDeepEqual(a.subarray(10,22),b.subarray(10,22));
  assert.notDeepEqual(a,b);
  assert.equal(a.includes(Buffer.from(fixtureText)),false);
  const independentlyOpened=openStandard(a,keys.primary);
  assert.deepEqual(independentlyOpened.documents[0].payload.governanceDocuments,state.governanceDocuments);
  assert.deepEqual(independentlyOpened.documents.map(d=>[d.scope,d.kind,d.generation]),[
    ['workspace:alpha','workbench',4],['workspace:alpha','workflow',2],['workspace:beta','workbench',1]
  ]);
  for(const path of [one,two,restored])assert.equal((await stat(path)).mode&0o777,0o600);
  const database=openSqlite(restored,{readOnly:true});
  try{assert.deepEqual(database.snapshot().documents,independentlyOpened.documents);}
  finally{database.close();}
  cli(['backup',paths.database,plain]);
  assert.deepEqual(verifyBackup(plain),independentlyOpened);
  cli(['restore',plain,join(dir,'plain-restored.sqlite')]);
  assert.match(cli(['verify-encrypted',plain,paths.primary],1),envelopeFailure);
  assert.ok((await readdir(dir)).every(path=>!path.endsWith('.tmp')));
});

test('authentication, header framing, truncation and no-clobber fail closed without publishing output',opts,async t=>{
  const {dir,paths}=await fixture(t);
  cli(['backup-encrypted',paths.database,paths.encrypted,paths.primary]);
  const original=await readFile(paths.encrypted),wrong=join(dir,'wrong.sqlite');
  assert.match(cli(['verify-encrypted',paths.encrypted,paths.different],1),/authentication failed/);
  assert.match(cli(['restore-encrypted',paths.encrypted,wrong,paths.different],1),/authentication failed/);
  await assert.rejects(access(wrong),{code:'ENOENT'});
  for(const [i,[mutated,expected]] of [
    [changed(original,0),envelopeFailure],[changed(original,8),envelopeFailure],
    [changed(original,9),envelopeFailure],[changed(original,22),envelopeFailure],
    [changed(original,10),/authentication failed/],[changed(original,64),/authentication failed/],
    [changed(original,original.length-1),/authentication failed/],[original.subarray(0,-1),envelopeFailure],
    [Buffer.concat([original,Buffer.from([0])]),envelopeFailure],[Buffer.alloc(15),envelopeFailure]
  ].entries()){
    const bad=join(dir,'altered-'+i),output=join(dir,'rejected-'+i+'.sqlite');
    await writeFile(bad,mutated,{mode:0o600});
    assert.match(cli(['restore-encrypted',bad,output,paths.primary],1),expected);
    await assert.rejects(access(output),{code:'ENOENT'});
  }
  const over=join(dir,'oversized.workbench');
  await writeFile(over,Buffer.alloc(0),{mode:0o600});
  await truncate(over,128*1024*1024+43);
  assert.match(cli(['verify-encrypted',over,paths.primary],1),envelopeFailure);
  const precious=join(dir,'not-a-target.sqlite');
  await writeFile(precious,'Existing synthetic sentinel.');
  assert.match(cli(['backup-encrypted',paths.database,paths.encrypted,paths.primary],1),/EEXIST/);
  assert.deepEqual(await readFile(paths.encrypted),original);
  assert.match(cli(['restore-encrypted',paths.encrypted,precious,paths.primary],1),/EEXIST/);
  assert.equal(await readFile(precious,'utf8'),'Existing synthetic sentinel.');
  assert.ok((await readdir(dir)).every(path=>!path.endsWith('.tmp')));
});

test('key inputs are exact raw private regular files; a read-only private key works and errors omit key values',opts,async t=>{
  const {dir,paths,keys}=await fixture(t);
  const good=join(dir,'read-only.workbench');
  cli(['backup-encrypted',paths.database,good,paths.different]);
  assert.deepEqual(cli(['verify-encrypted',good,paths.different]),summary);
  const permissive=join(dir,'permissive.key'),short=join(dir,'short.key'),hex=join(dir,'hex.key');
  const symbolic=join(dir,'symbolic.key'),hard=join(dir,'hard.key'),none=join(dir,'missing.key');
  await writeFile(permissive,keys.primary,{mode:0o600});await chmod(permissive,0o640);
  await writeFile(short,keys.primary.subarray(0,31),{mode:0o600});
  await writeFile(hex,keys.primary.toString('hex')+'\n',{mode:0o600});
  await symlink(paths.different,symbolic);
  await link(paths.primary,hard);
  for(const key of [permissive,short,hex,symbolic,hard,paths.primary,none,dir]){
    const stderr=cli(['verify-encrypted',good,key],1);
    assert.match(stderr,keyFailure);
    assert.ok(!stderr.includes(keys.primary.toString('hex'))&&!stderr.includes(keys.different.toString('base64')));
  }
});

test('a valid GCM tag cannot bypass inner checksum, governance integrity, or mode verification',opts,async t=>{
  const {dir,paths,keys}=await fixture(t);
  cli(['backup-encrypted',paths.database,paths.encrypted,paths.primary]);
  const good=openStandard(await readFile(paths.encrypted),keys.primary);
  for(const [i,[label,alter,recompute]] of [
    [/checksum mismatch/,content=>{content.sha256='f'.repeat(64);},false],
    [/retention holds|attachment quarantine/,content=>{
      content.documents[0].payload.governanceDocuments.documents[0].revisions[0].attachments[0].quarantine={status:'released'};
    },true],
    [/scope does not match/,content=>{content.mode='demo';},true]
  ].entries()){
    const content=structuredClone(good);alter(content);
    if(recompute){const {sha256,...inner}=content;content.sha256=hash(JSON.stringify(inner));}
    const bad=join(dir,'authenticated-'+i),output=join(dir,'invalid-'+i+'.sqlite');
    await writeFile(bad,sealStandard(content,keys.primary),{mode:0o600});
    assert.match(cli(['verify-encrypted',bad,paths.primary],1),label);
    assert.match(cli(['restore-encrypted',bad,output,paths.primary],1),label);
    await assert.rejects(access(output),{code:'ENOENT'});
  }
});
