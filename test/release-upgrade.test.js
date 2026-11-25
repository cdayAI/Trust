'use strict';

const assert=require('node:assert/strict');
const {execFile,spawn}=require('node:child_process');
const http=require('node:http');
const {constants}=require('node:fs');
const {createHash,randomBytes}=require('node:crypto');
const {copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {test}=require('node:test');
const {promisify}=require('node:util');
const {backupDatabase,restoreDatabase,verifyBackup,captureBackup}=require('../durable-storage');
const {sourceManifest}=require('../scripts/package-release');

const sha=value=>createHash('sha256').update(value).digest('hex');
const exec=promisify(execFile);
const current=resolve(__dirname,'..');
const baselineArchive=process.env.MVW_TRUST_STAGE20_ARCHIVE;
const baselineBytes=821023;
const baselineSha='8abf638613d03d65f99c4c6eac95ee38adb6a4fa0ee7ca4ce008b343a1a5ef46';
const runtimeFiles=['workspace.sqlite','release-profile.json','release-lease.sqlite'];
const scope='harbor';
const rights='/api/rights/cases',docs='/api/governance-documents',portal='/api/requester';
const waitMs=16000;
const roleIds={analyst:'sample-intake',reviewer:'sample-review',operator:'sample-case-operator',admin:'sample-identity-admin'};
const note='Fictional stage20 verification only';
const evidence=Buffer.from('Fictional stage20 artifact payload.\nThis has only a test verification marker.\n');
const evidenceHash=sha(evidence);

async function launch(t,root,codeDir,args=[]){
  const child=spawn(process.execPath,[join(codeDir,'start-release.js'),...args],{
    cwd:root,env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},stdio:['ignore','pipe','pipe'],
  });
  let output='',stderr='',timer;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
  const done=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  done.catch(()=>{});
  const stop=async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    const result=await done;
    if(process.platform!=='win32')assert.equal(result.code,0,'Launcher should shut down gracefully.');
  };
  t.after(stop);
  const ready=await Promise.race([
    new Promise(resolve=>child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(JSON.parse(output.trim()));})),
    done.then(()=>{throw new Error('Archived or current launcher refused startup: '+stderr);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Release did not announce readiness.')),waitMs);}),
  ]).finally(()=>clearTimeout(timer));
  assert.equal(ready.status,'ready');
  assert.match(ready.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const credentials=JSON.parse(await readFile(ready.accessFile,'utf8'));
  assert.ok(credentials.staff.every(row=>!output.includes(row.code)&&!stderr.includes(row.code)));
  function req(route,status,{body,cookie,workspace}={}){
    return new Promise((resolve,reject)=>{
      const payload=body===undefined?undefined:JSON.stringify(body);
      const request=http.request({hostname:'127.0.0.1',port:new URL(ready.url).port,
        path:route+(workspace?'?workspace='+workspace:''),signal:AbortSignal.timeout(6000),
        method:payload===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),
          ...(payload===undefined?{}:{Origin:ready.url,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)})}},
      response=>{
        const chunks=[];
        let size=0;
        response.once('error',reject);
        response.on('data',chunk=>{
          size+=chunk.length;
          if(size>4*1024*1024){request.destroy(new Error('Rehearsal response exceeded its fixed bound.'));return;}
          chunks.push(chunk);
        });
        response.on('end',()=>{
          try{
            assert.equal(response.statusCode,status,route);
            const bytes=Buffer.concat(chunks),data=response.headers['content-type']?.startsWith('application/json')?
              JSON.parse(bytes):bytes;
            resolve({data,cookie:response.headers['set-cookie']?.[0]?.split(';')[0]});
          }catch(error){reject(error);}
        });
      });
      request.once('error',reject);
      request.end(payload);
    });
  }
  const staff=(route,status,cookie,body,workspace=scope)=>req(route,status,{cookie,body,workspace}).then(x=>x.data);
  const requester=(op,status,body={},workspace=scope)=>req(portal+'/'+op,status,{body:{
    code:credentials.requesters.find(row=>row.workspace===workspace).code,...body,
  }}).then(x=>x.data);
  const login=async(role,workspace=scope)=>{
    const seat=credentials.staff.find(item=>item.id===roleIds[role]);
    return (await req('/api/session/login',200,{body:{account:seat.id,code:seat.code,workspace}})).cookie;
  };
  return {ready,credentials,req,staff,requester,login,stop};
}
async function cloneRun(root,backup,profile){
  const folder=await mkdtemp(join(root,'mvw-trust-release-'));
  if(process.platform!=='win32')assert.equal((await stat(folder)).mode&0o777,0o700);
  const room=join(folder,'workspaces');
  await mkdir(room,{mode:0o700});
  for(const scope of ['harbor','orchard'])await mkdir(join(room,scope),{mode:0o700});
  await writeFile(join(folder,'release-profile.json'),profile,{flag:'wx',mode:0o600,flush:true});
  // A new lease is operational metadata, not a copied process lock.
  const lease=join(folder,'release-lease.sqlite');
  await writeFile(lease,'',{flag:'wx',mode:0o600,flush:true});
  assert.deepEqual(restoreDatabase(backup,join(folder,'workspace.sqlite')),{mode:'isolated',documents:2});
  assert.deepEqual((await readdir(folder)).sort(),[...runtimeFiles,'workspaces'].sort());
  return folder;
}
async function retainedFiles(room){
  return Object.fromEntries(await Promise.all(runtimeFiles.map(async name=>[name,sha(await readFile(join(room,name)))])));
}
function caseFields(model,id){
  const {id:stored,revision,kind,status,identity,owner,summary,receivedAt,dueDate,clockPolicy}=
    model.cases.find(row=>row.id===id);
  return {id:stored,revision,kind,status,identity,owner,summary,receivedAt,dueDate,clockPolicy};
}
function evidenceFields(model,id){
  const doc=model.documents.find(row=>row.id===id),rev=doc.revisions.find(row=>row.id===doc.currentRevisionId);
  return {id:doc.id,edition:rev.id,version:rev.number,status:rev.status,title:rev.title,contentHash:rev.contentHash,
    attachments:rev.attachments.map(x=>({id:x.id,name:x.name,sha256:x.sha256,size:x.size,reviewStatus:x.reviewStatus})),
  };
}
function reviewVersion(model){return {expectedRevision:model.version,digest:model.digest};}
test('optional published stage20 upgrade rehearsal verifies retained release bindings on a private copy',{
  skip:!baselineArchive&&'Set MVW_TRUST_STAGE20_ARCHIVE to the original stage20 checkpoint ZIP',timeout:60000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'trust-release-stage20-rehearsal-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:2}));
  const archive=join(root,'exact-stage20.zip');
  const archiveSource=resolve(baselineArchive),original=await lstat(archiveSource);
  assert.ok(original.isFile()&&original.size===baselineBytes,'Select the exact standalone stage20 ZIP.');
  await copyFile(archiveSource,archive,constants.COPYFILE_EXCL);
  assert.equal(sha(await readFile(archive)),baselineSha,'Refuse any archive other than the pinned stage20 release.');
  const historical=join(root,'stage20-original-code');
  await mkdir(historical,{mode:0o700});
  await exec('unzip',['-q',archive,'-d',historical],{cwd:root,timeout:waitMs});
  const previous=await launch(t,root,historical);
  const [a,r,o,m]=await Promise.all(['analyst','reviewer','operator','admin'].map(role=>previous.login(role)));
  const start=async label=>{
    const result=await previous.staff(rights,200,a,{kind:'access',owner:'case-operator',days:9,note:label});
    return result.cases.at(-1);
  };
  const caseA=await start('Fictional stage20 delegated case'),caseB=await start('Fictional stage20 withheld case');
  await previous.staff(rights+'/'+caseA.id+'/delegation',200,a,{operation:'delegate',account:roleIds.operator,
    reason:'case-assignment',expectedRevision:caseA.revision});
  assert.deepEqual((await previous.staff(rights,200,o)).cases.map(row=>row.id),[caseA.id]);

  const assembled=await previous.staff(docs+'/records',200,a,{kind:'evidence',title:'Fictional upgrade-bound evidence',
    content:'Fictional stage20 content. Do not treat as a real record.',links:[{type:'rights-case',id:caseA.id}],expectedRevision:0});
  const doc=assembled.documents[0],edition=doc.revisions[0],path=docs+'/records/'+doc.id+'/revisions/'+edition.id;
  const uploaded=await previous.staff(path+'/attachments/batch',200,a,{expectedRevision:assembled.revision,files:[
    {filename:'Fictional stage20 evidence.txt',mediaType:'text/plain',data:evidence.toString('base64')},
  ]});
  const attachment=uploaded.documents[0].revisions[0].attachments[0],artifact=path+'/attachments/'+attachment.id;
  assert.equal(attachment.sha256,evidenceHash);
  assert.equal(attachment.reviewStatus,'pending');
  await previous.staff(artifact+'/download',409,r,{});
  const checked=await previous.staff(artifact+'/review',200,r,{operation:'release',sha256:evidenceHash,expectedRevision:uploaded.revision});
  const submitted=await previous.staff(path+'/submit',200,a,{expectedRevision:checked.revision});
  await previous.staff(path+'/publish',200,r,{expectedRevision:submitted.revision,note});
  await previous.staff(artifact+'/download',404,o,{});
  const pending=await previous.staff('/api/document-access',200,r,{operation:'propose',account:roleIds.operator,document:doc.id,
    edition:edition.id,level:'text-and-attachments',expectedRevision:0,reason:'operational-need'});
  const grant=pending.grants[0];
  await previous.staff('/api/document-access',200,m,{operation:'approve',grant:grant.id,
    expectedRevision:pending.revision,reason:'scope-review'});
  assert.deepEqual(await previous.staff(artifact+'/download',200,o,{}),evidence);

  const portalReceipt=await previous.requester('intake',200,{kind:'access'});
  const portalCase=(await previous.staff(rights,200,a)).cases.at(-1);
  const portalPath=rights+'/'+portalCase.id;
  await previous.staff(portalPath+'/verify',200,r,{expectedRevision:1,note});
  await previous.staff(portalPath+'/begin',200,a,{expectedRevision:2,note});
  await previous.staff(portalPath+'/fulfill',200,a,{expectedRevision:3,note});
  const resultRoute=portalPath+'/result/';
  const authored=(await previous.staff(resultRoute+'draft',200,a,{expectedRevision:0,selection:'summary-only'})).cases
    .find(row=>row.id===portalCase.id).resultDelivery;
  await previous.staff(resultRoute+'submit',200,a,reviewVersion(authored));
  await previous.staff(resultRoute+'approve',200,r,reviewVersion(authored));
  await previous.staff(resultRoute+'release',200,r,{...reviewVersion(authored),confirm:true});
  const oldPortalStatus=await previous.requester('status',200),oldPortalResult=await previous.requester('result',200);
  assert.equal(oldPortalStatus.receipt,portalReceipt.receipt);
  assert.deepEqual(oldPortalResult.result.sections,[{label:'Fictional example records',count:3}]);

  const before={case:caseFields(await previous.staff(rights,200,a),caseA.id),
    restricted:caseFields(await previous.staff(rights,200,a),caseB.id),
    evidence:evidenceFields(await previous.staff(docs,200,o),doc.id),audit:(await previous.staff('/api/audit/export',200,r)).audit};
  await previous.stop();
  if(process.platform!=='win32')await assert.rejects(stat(previous.ready.accessFile),{code:'ENOENT'});
  const savedRoom=previous.ready.runDirectory,sourceBytes=await retainedFiles(savedRoom);
  const sourceListing=(await readdir(savedRoom,{recursive:true})).sort();
  const profile=await readFile(join(savedRoom,'release-profile.json'));
  const backup=join(root,'verified-old-snapshot.json'),oldStorage=join(savedRoom,'workspace.sqlite');
  const captured=backupDatabase(oldStorage,backup),envelope=verifyBackup(backup);
  assert.equal(captured.sha256,envelope.sha256);
  assert.equal(envelope.mode,'isolated');
  assert.deepEqual(envelope.documents.map(d=>d.scope),['workspace:harbor','workspace:orchard']);
  assert.deepEqual(await retainedFiles(savedRoom),sourceBytes);

  const copy=await cloneRun(root,backup,profile);
  assert.deepEqual(captureBackup(join(copy,'workspace.sqlite')),envelope);
  const upgraded=await launch(t,root,current,['--resume',copy]);
  assert.notEqual(upgraded.ready.runDirectory,savedRoom);
  assert.equal(upgraded.ready.resumed,true);
  assert.notEqual(upgraded.ready.accessFile,previous.ready.accessFile);
  // Negative only: an old session is never used to gain access in current.
  for(const oldSession of [a,r,o,m])await upgraded.staff('/api/state',401,oldSession);
  for(const key of ['staff','requesters','employees','learners'])
    assert.equal(sha(JSON.stringify(upgraded.credentials[key].map(x=>x.code))),
      sha(JSON.stringify(previous.credentials[key].map(x=>x.code))),'Saved bindings must not rotate.');
  const [newA,newR,newO,newOrchard]=await Promise.all([
    upgraded.login('analyst'),upgraded.login('reviewer'),upgraded.login('operator'),upgraded.login('operator','orchard'),
  ]);
  assert.ok(![a,r,o,m].includes(newO));
  const afterCases=await upgraded.staff(rights,200,newA);
  assert.deepEqual(caseFields(afterCases,caseA.id),before.case);
  assert.deepEqual(caseFields(afterCases,caseB.id),before.restricted);
  assert.deepEqual((await upgraded.staff(rights,200,newO)).cases.map(row=>row.id),[caseA.id]);
  assert.deepEqual((await upgraded.staff(rights,200,newOrchard,undefined,'orchard')).cases,[]);
  await upgraded.staff(rights,403,newOrchard);
  assert.deepEqual((await upgraded.staff('/api/audit/export',200,newR)).audit,before.audit);
  assert.deepEqual(evidenceFields(await upgraded.staff(docs,200,newO),doc.id),before.evidence);
  assert.deepEqual(await upgraded.staff(artifact+'/download',200,newO,{}),evidence);
  await upgraded.staff(artifact+'/download',404,newOrchard,{},'orchard');
  assert.deepEqual(await upgraded.requester('status',200),oldPortalStatus);
  assert.deepEqual(await upgraded.requester('result',200),oldPortalResult);
  assert.equal((await upgraded.requester('result',200,{},'orchard')).status,'not-available');
  await upgraded.stop();

  const originalProfile=JSON.parse(profile);
  for(const wrong of [{...originalProfile,seed:randomBytes(32).toString('hex')},{...originalProfile,schemaVersion:999}]){
    const invalid=await cloneRun(root,backup,JSON.stringify(wrong)+'\n');
    const beforeRefusal=await retainedFiles(invalid);
    await assert.rejects(exec(process.execPath,[join(current,'start-release.js'),'--resume',invalid],{
      cwd:root,env:{...process.env,TMPDIR:root,TMP:root,TEMP:root},timeout:waitMs,
    }),error=>error.code===1&&error.stdout===''&&error.stderr.includes('saved release'));
    assert.deepEqual(await retainedFiles(invalid),beforeRefusal);
    assert.ok(!(await readdir(invalid)).includes('synthetic-access.json'));
  }
  assert.deepEqual(await retainedFiles(savedRoom),sourceBytes);
  assert.deepEqual((await readdir(savedRoom,{recursive:true})).sort(),sourceListing);
  assert.equal(sha(await readFile(archive)),baselineSha);
  assert.equal(sha(await readFile(archiveSource)),baselineSha);
  const manifest=sourceManifest(current).manifest;
  t.diagnostic(JSON.stringify({baselineStage:'stage20',archiveSha256:baselineSha,testedSourceManifestSha256:sha(JSON.stringify(manifest)),
    historicalAuditEvents:before.audit.length,fixtureOnly:true}));
});
