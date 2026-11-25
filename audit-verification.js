'use strict';

const {createHash}=require('node:crypto');
const audits=require('./audit-management');
const remediation=require('./audit-remediation');
const FORMAT='mvw-trust-synthetic-audit-verification-v1';
const MAX_BYTES=8*1024*1024;
const MAX_FILES=21;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n','utf8');
const compare=(a,b)=>a<b?-1:a>b?1:0;
function reject(code,message,status=422){throw Object.assign(Error(message),{status,code})}
function requireValue(test,code,message){if(!test)reject(code,message);}
const fields=(x,keys)=>!!(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)));
const id=x=>typeof x==='string'&&uuid.test(x);
const hash=x=>typeof x==='string'&&hex.test(x);
const tidy=x=>typeof x==='string'&&x.length>0&&x.length<=128&&!/[\x00-\x1f\x7f]/u.test(x);
function canonical(x){
  if(x===null||typeof x!=='object')return JSON.stringify(x);
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  return '{'+Object.keys(x).sort(compare).map(key=>JSON.stringify(key)+':'+canonical(x[key])).join(',')+'}';
}
function validScope(scope){
  return fields(scope,['mode','workspace','actor','role'])&&['analyst','reviewer'].includes(scope.role)&&tidy(scope.actor)&&
    (scope.mode==='local-isolated'&&tidy(scope.workspace)||
      scope.mode==='synthetic-demo'&&scope.workspace===null&&scope.actor===scope.role);
}
function addFile(files,wrapper,meta){
  const bytes=jsonBytes(wrapper);
  files.push({id:meta.id,base64:bytes.toString('base64')});
  return {...meta,sha256:sha(bytes),bytes:bytes.length};
}
function create(state,auditId,scope){
  if(!validScope(scope))reject('AUDIT_PACKAGE_SCOPE','An analyst or reviewer workspace context is required.',403);
  const audit=audits.report(state,auditId);
  const files=[];
  const entries=[addFile(files,audit,{id:'audit:'+auditId,kind:'finalized-audit'})];
  for(const row of (state.auditRemediation??[]).filter(r=>r.finding.planId===auditId&&r.attempts.some(a=>a.decision?.outcome==='closed'))
    .sort((a,b)=>compare(a.id,b.id))){
    const closure=remediation.report(state,row.id);
    const receipts=closure.closures.map(x=>({attempt:x.result.attempt.number,testId:x.result.attempt.proof.id,sha256:x.sha256}));
    entries.push(addFile(files,closure,{id:'closure:'+row.id,kind:'corrective-closure',actionId:row.id,findingId:row.finding.id,receipts}));
  }
  const manifest={schemaVersion:1,format:FORMAT,scope:{...scope},auditId,auditFinalSha256:audit.sha256,entries};
  const bundle={manifest,manifestSha256:sha(canonical(manifest)),files};
  if(jsonBytes(bundle).length>MAX_BYTES)reject('AUDIT_PACKAGE_LIMIT','This audit exceeds the offline package size limit.',413);
  // Verify source link integrity before authorizing it as an exportable package.
  try{verify(bundle)}catch(e){if(e.status===422)reject('AUDIT_PACKAGE_SOURCE_INCONSISTENT','Finalized audit or closure source failed integrity checks.',409);throw e;}
  return bundle;
}
function parseExact(raw,errorCode,label){
  let content;
  try{content=JSON.parse(raw.toString('utf8'))}catch{reject(errorCode,label+' is not valid JSON.');}
  let exact=false;
  try{exact=jsonBytes(content).equals(raw)}catch{reject(errorCode,label+' has unsupported JSON nesting.');}
  requireValue(exact,errorCode,label+' is not the original JSON encoding.');
  return content;
}
function decode(file,entry){
  requireValue(fields(file,['id','base64'])&&file.id===entry.id&&typeof file.base64==='string'&&
    file.base64.length===4*Math.ceil(entry.bytes/3),'AUDIT_PACKAGE_FILE','Invalid, missing or reordered packaged file.');
  const bytes=Buffer.from(file.base64,'base64');
  requireValue(bytes.length===entry.bytes&&bytes.toString('base64')===file.base64&&sha(bytes)===entry.sha256,
    'AUDIT_PACKAGE_DIGEST','Packaged file checksum or size mismatch.');
  return parseExact(bytes,'AUDIT_PACKAGE_FILE','Packaged source');
}
function verify(bundle,{expectedManifestSha256}={}){
  requireValue(fields(bundle,['manifest','manifestSha256','files']),'AUDIT_PACKAGE_SHAPE','Invalid audit package.');
  const {manifest,manifestSha256,files}=bundle;
  requireValue(fields(manifest,['schemaVersion','format','scope','auditId','auditFinalSha256','entries'])&&
    manifest.schemaVersion===1&&manifest.format===FORMAT&&validScope(manifest.scope)&&id(manifest.auditId)&&hash(manifest.auditFinalSha256)&&
    Array.isArray(manifest.entries)&&manifest.entries.length>=1&&manifest.entries.length<=MAX_FILES&&
    Array.isArray(files)&&files.length===manifest.entries.length,'AUDIT_PACKAGE_MANIFEST','Invalid manifest or missing/extra package files.');
  const entryIds=new Set(),findingIds=new Set(),currentFindings=new Map();
  let closureCount=0,lastClosure='',total=0;
  for(const [i,entry] of manifest.entries.entries()){
    const audit=i===0;
    const keys=audit?['id','kind','sha256','bytes']:['id','kind','actionId','findingId','receipts','sha256','bytes'];
    requireValue(fields(entry,keys)&&hash(entry.sha256)&&Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&
      (total+=entry.bytes)<=MAX_BYTES&&!entryIds.has(entry.id),'AUDIT_PACKAGE_ENTRY','Duplicate or invalid manifest entry.');
    entryIds.add(entry.id);
    if(audit)requireValue(entry.kind==='finalized-audit'&&entry.id==='audit:'+manifest.auditId,'AUDIT_PACKAGE_ENTRY','The finalized audit entry is missing.');
    else{
      requireValue(entry.kind==='corrective-closure'&&id(entry.actionId)&&entry.id==='closure:'+entry.actionId&&id(entry.findingId)&&
        compare(lastClosure,entry.id)<0&&!findingIds.has(entry.findingId)&&Array.isArray(entry.receipts)&&entry.receipts.length>=1&&entry.receipts.length<=50,
        'AUDIT_PACKAGE_ENTRY','Duplicate, unsorted or invalid closure reference.');
      findingIds.add(entry.findingId);lastClosure=entry.id;
    }
    const decoded=decode(files[i],entry);
    if(audit){
      requireValue(fields(decoded,['schemaVersion','mode','result','sha256'])&&decoded.schemaVersion===1&&decoded.mode==='synthetic-local'&&
        decoded.result?.id===manifest.auditId&&decoded.sha256===manifest.auditFinalSha256&&sha(JSON.stringify(decoded.result))===decoded.sha256&&
        Array.isArray(decoded.result.controls)&&Array.isArray(decoded.result.reviewHistory)&&decoded.result.reviewHistory.at(-1)?.decision==='finalized',
        'AUDIT_PACKAGE_AUDIT','Finalized audit payload or content checksum is inconsistent.');
      for(const row of decoded.result.controls){
        if(!row?.assessment?.finding)continue;
        const {finding}=row.assessment;
        requireValue(id(finding.id)&&id(row.control?.id)&&row.assessment.controlId===row.control.id&&row.assessment.outcome==='exception'&&
          !currentFindings.has(finding.id),'AUDIT_PACKAGE_FINDING','Duplicate or invalid finalized finding.');
        currentFindings.set(finding.id,{controlId:row.control.id,severity:finding.severity,proposedAction:finding.correctiveAction});
      }
      continue;
    }
    const finding=currentFindings.get(entry.findingId);
    requireValue(!!finding&&fields(decoded,['schemaVersion','scope','findingId','closures'])&&decoded.schemaVersion===1&&
      decoded.scope==='synthetic-audit-remediation'&&decoded.findingId===entry.findingId&&Array.isArray(decoded.closures)&&
      decoded.closures.length===entry.receipts.length,'AUDIT_PACKAGE_REFERENCE','Closure file is missing or refers to an unrelated finalized finding.');
    let priorAttempt=0;
    const tests=new Set();
    for(const [j,receipt] of entry.receipts.entries()){
      const wrapped=decoded.closures[j];
      const result=wrapped?.result,attempt=result?.attempt,source=result?.finding,proof=attempt?.proof,decision=attempt?.decision;
      requireValue(fields(receipt,['attempt','testId','sha256'])&&Number.isSafeInteger(receipt.attempt)&&receipt.attempt>priorAttempt&&
        id(receipt.testId)&&!tests.has(receipt.testId)&&hash(receipt.sha256)&&fields(wrapped,['result','sha256'])&&
        receipt.sha256===wrapped.sha256&&!!result&&sha(JSON.stringify(result))===wrapped.sha256&&result.actionId===entry.actionId&&
        source?.id===entry.findingId&&source.planId===manifest.auditId&&source.auditSha256===manifest.auditFinalSha256&&
        source.controlId===finding.controlId&&source.severity===finding.severity&&source.proposedAction===finding.proposedAction&&
        receipt.attempt===attempt?.number&&receipt.testId===proof?.id&&proof.controlId===finding.controlId&&proof.outcome==='pass'&&
        tidy(proof.recordedBy)&&tidy(proof.reviewedBy)&&proof.recordedBy!==proof.reviewedBy&&decision?.outcome==='closed'&&
        tidy(result.owner)&&result.owner===attempt.submittedBy&&tidy(decision.reviewer)&&result.owner!==decision.reviewer,
        'AUDIT_PACKAGE_RECEIPT','Duplicate, missing or inconsistent approved closure receipt.');
      priorAttempt=receipt.attempt;tests.add(receipt.testId);closureCount++;
    }
  }
  requireValue(hash(manifestSha256)&&sha(canonical(manifest))===manifestSha256,'AUDIT_PACKAGE_DIGEST','Manifest checksum mismatch.');
  if(expectedManifestSha256!==undefined)requireValue(hash(expectedManifestSha256)&&manifestSha256===expectedManifestSha256,
    'AUDIT_PACKAGE_EXPECTED_DIGEST','Manifest does not match the independently recorded checksum.');
  return {auditId:manifest.auditId,scope:manifest.scope,manifestSha256,files:files.length,approvedClosures:closureCount,
    verification:expectedManifestSha256===undefined?'internal-checksums-only':'independently-recorded-checksum-matched',
    signatureAuthenticity:false};
}
function verifyBytes(raw,options){
  if(!Buffer.isBuffer(raw)||raw.length>MAX_BYTES)reject('AUDIT_PACKAGE_LIMIT','Audit package exceeds the offline file size limit.',413);
  return verify(parseExact(raw,'AUDIT_PACKAGE_SHAPE','Audit package'),options);
}
module.exports={MAX_BYTES,create,verify,verifyBytes};
