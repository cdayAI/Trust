'use strict';

const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const source='fictional-preference-ledger-v1';
const schemaVersion=1;
const format='synthetic-rights-retrieval';
const limit=16;
const auditActions={retrieve:'draft',submit:'review',return:'returned',approve:'approved'};
const allowedCategories=[['preference','Fictional preference examples'],['service','Fictional service examples']];
const sample=(category,id)=>Object.freeze({category,
  internalRecordId:'FIXTURE-DENIED-RECORD-'+id,
  privateMemo:'FIXTURE-DENIED-MEMO-'+id,
  internalDebug:'FIXTURE-DENIED-DEBUG-'+id});
const buckets=Object.freeze([
  Object.freeze([sample('preference','a1'),sample('preference','a2'),sample('service','a3')]),
  Object.freeze([sample('preference','b1'),sample('service','b2'),sample('service','b3'),sample('service','b4')]),
]);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const missing=()=>fail(404,'RETRIEVAL_NOT_FOUND','Eligible fictional retrieval case not found.');
const stale=()=>fail(409,'STALE_RETRIEVAL','The case or retrieval revision changed. Reload before retrying.');
const exact=(body,keys)=>!!body&&typeof body==='object'&&!Array.isArray(body)&&
  Object.keys(body).length===keys.length&&keys.every(k=>Object.hasOwn(body,k));
function usable(ctx){
  return !!ctx?.activeReleaseBinding&&typeof ctx.workspace==='string'&&['analyst','reviewer'].includes(ctx.role);
}
function eligible(row){
  return row?.owner==='analyst'&&row.kind==='access'&&row.source==='synthetic-portal'&&row.status==='in-progress'&&
    !row.closedAt&&row.identity?.status==='verified';
}
function offerCaseIds(state,ctx){
  const offered=new Set();
  if(!usable(ctx))return offered;
  const cases=new Map();
  for(const entry of state.requesterReceipts??[])cases.set(entry.caseId,cases.has(entry.caseId)?null:entry);
  for(const row of state.rightsCases??[]){
    const receipt=cases.get(row.id);
    if(!eligible(row)||!receipt?.resultBinding||receipt.resultBinding!==ctx.activeReleaseBinding(receipt.grantId))continue;
    if(ctx.role==='reviewer'){
      const latest=state.rightsRetrievals?.[row.id]?.at(-1);
      if(!latest||!['review','approved'].includes(latest.status)||latest.authoredBy===ctx.account||
        latest.caseId!==row.id||latest.workspace!==ctx.workspace||latest.caseRevision!==row.revision||latest.binding!==receipt.resultBinding)
        continue;
    }
    // This is not a review or source read: no stored projection, digest or
    // fixture record is touched until the panel requests the scoped route.
    offered.add(row.id);
  }
  return offered;
}
function context(state,caseId,ctx){
  if(!usable(ctx))return missing();
  const row=(state.rightsCases??[]).find(item=>item.id===caseId);
  if(!eligible(row))return missing();
  const receipts=(state.requesterReceipts??[]).filter(entry=>entry.caseId===caseId);
  if(receipts.length!==1||!receipts[0].resultBinding||receipts[0].resultBinding!==ctx.activeReleaseBinding(receipts[0].grantId))
    return missing();
  return {row,binding:receipts[0].resultBinding};
}
function project(workspace,caseId){
  const bucket=parseInt(digest([source,workspace,caseId]).slice(0,2),16)%buckets.length;
  const selected=buckets[bucket];
  // The actual transform reads only the explicit category enum. It never
  // enumerates or copies source record objects or other field values.
  const categories=allowedCategories.map(([category,label])=>({
    category,label,count:selected.filter(row=>row.category===category).length,
  })).filter(row=>row.count>0);
  return {schemaVersion,categories,rowsReviewed:selected.length};
}
function tuple(record){
  return [format,record.workspace,record.caseId,record.caseRevision,record.binding,record.revision,record.source,record.projection];
}
function sealed(record,row,binding,workspace){
  if(!record||record.workspace!==workspace||record.caseId!==row.id||record.binding!==binding||
    record.caseRevision!==row.revision||record.source!==source||!Number.isSafeInteger(record.revision)||record.revision<=0)return null;
  const output=project(workspace,row.id);
  if(!isDeepStrictEqual(record.projection,output)||record.digest!==digest(tuple(record)))return null;
  return output;
}
function inspect(state,caseId,ctx){
  const {row,binding}=context(state,caseId,ctx),versions=state.rightsRetrievals?.[caseId]??[],previous=versions.at(-1);
  if(previous&&(previous.workspace!==ctx.workspace||previous.caseId!==row.id))return missing();
  const projection=sealed(previous,row,binding,ctx.workspace);
  if(ctx.role==='reviewer'&&(!projection||!['review','approved'].includes(previous.status)))return missing();
  const actions=[],isAuthor=previous?.authoredBy===ctx.account;
  const stage=!previous?'not-retrieved':(!projection?'stale':previous.status);
  if(ctx.role==='analyst'&&versions.length<limit&&(!previous||(isAuthor&&(!projection||['draft','returned'].includes(previous.status)))))
    actions.push('retrieve');
  if(ctx.role==='analyst'&&projection&&isAuthor&&stage==='draft')actions.push('submit');
  if(ctx.role==='reviewer'&&projection&&!isAuthor&&stage==='review')actions.push('approve','return');
  return {mode:format,caseId:row.id,caseRevision:row.revision,source,revision:previous?.revision??0,stage,actions,
    ...(projection?{projection,digest:previous.digest}:{})};
}
function change(state,caseId,action,ctx,body,event){
  if(!Object.hasOwn(auditActions,action))return missing();
  const {row,binding}=context(state,caseId,ctx);
  const operationRole=['retrieve','submit'].includes(action)?'analyst':'reviewer';
  if(ctx.role!==operationRole)fail(403,'RETRIEVAL_ROLE','The assigned retrieval role is required.');
  const keys=['expectedCaseRevision','expectedRevision',action==='retrieve'?'source':'digest'];
  if(!exact(body,keys)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||
    !Number.isSafeInteger(body.expectedCaseRevision)||body.expectedCaseRevision<1)
    fail(422,'RETRIEVAL_FIELDS','Use only the exact fictional retrieval fields.');
  const versions=state.rightsRetrievals?.[caseId]??[],previous=versions.at(-1);
  if(body.expectedCaseRevision!==row.revision||body.expectedRevision!==(previous?.revision??0)||
    (action!=='retrieve'&&(!sealed(previous,row,binding,ctx.workspace)||body.digest!==previous.digest)))return stale();
  const model=inspect(state,caseId,ctx);
  if(!model.actions.includes(action))fail(409,'RETRIEVAL_ACTION','This stage does not permit the requested action.');
  const now=new Date().toISOString();
  let record=previous;
  if(action==='retrieve'){
    if(body.source!==source)fail(422,'RETRIEVAL_SOURCE','Only the bundled fictional source is supported.');
    record={workspace:ctx.workspace,caseId:row.id,caseRevision:row.revision,binding,revision:versions.length+1,
      source,projection:project(ctx.workspace,row.id),status:'draft',authoredBy:ctx.account,authoredAt:now};
    record.digest=digest(tuple(record));
    (state.rightsRetrievals??={})[caseId]=[...versions,record];
  }else{
    record.status=auditActions[action];
    if(action==='approve'){record.reviewedBy=ctx.account;record.reviewedAt=now;}
  }
  event(state,ctx.role,'rights-retrieval.'+action,null,row.id,{revision:record.revision,caseRevision:record.caseRevision,stage:record.status});
  // A return is a successful state transition, while the returned preview
  // is no longer the reviewer's to inspect.
  if(action==='return')return {mode:format,stage:'returned',revision:record.revision};
  return inspect(state,caseId,ctx);
}
module.exports={inspect,change,offerCaseIds};
