'use strict';

const identity=require('./identity-admin');
const authorship=require('./document-provenance');
const accountPattern=/^sample-[a-z0-9][a-z0-9-]{0,39}$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const countLimit=512;
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const missing=()=>fail(404,'REVIEW_EDITION_NOT_FOUND','That document review edition was not found.');
const valid=(pattern,value)=>typeof value==='string'&&pattern.test(value);
function provision(isolated,synthetic){
  const entries=isolated?.documentReviewSeats;
  if(entries===undefined)return new Map();
  if(!synthetic)throw Error('Restricted document reviewer seats are available only in local synthetic mode.');
  if(!Array.isArray(entries)||!entries.length||!Array.isArray(isolated.workspaces)||!Array.isArray(isolated.accounts))
    throw Error('Invalid restricted document reviewer provisioning.');
  const result=new Map();
  for(const item of entries){
    if(!item||Object.keys(item).length!==2||!isolated.workspaces.some(space=>space.id===item.workspace)||
      result.has(item.workspace)||!valid(accountPattern,item.account))
      throw Error('Provide one explicit synthetic reviewer account per workspace.');
    const reviewers=isolated.accounts.filter(a=>a.memberships?.[item.workspace]==='reviewer');
    if(reviewers.length!==2||!reviewers.some(a=>a.id===item.account)||
      !reviewers.every(a=>valid(accountPattern,a.id))||
      !isolated.accounts.some(a=>a.memberships?.[item.workspace]==='analyst'))
      throw Error('A restricted review seat requires one separate primary reviewer and an analyst.');
    result.set(item.workspace,item.account);
  }
  return result;
}
function primaryConfig(isolated,seats){
  if(!seats.size)return isolated;
  return {...isolated,accounts:isolated.accounts.flatMap(account=>{
    const memberships=Object.fromEntries(Object.entries(account.memberships??{}).filter(([space])=>seats.get(space)!==account.id));
    return Object.keys(memberships).length?[{...account,memberships}]:[];
  })};
}
function records(state){
  const data=state.documentReviewerAssignments;
  if(data===undefined)return [];
  if(data?.version!==1||!Array.isArray(data.rows)||data.rows.length>countLimit||
    new Set(data.rows.map(row=>row?.edition)).size!==data.rows.length||
    data.rows.some(row=>!row||!valid(uuid,row.edition)||!valid(uuid,row.document)||!valid(uuid,row.submission)||
      !valid(accountPattern,row.account)||!Number.isSafeInteger(row.generation)||row.generation<0||!valid(hash,row.provisioning)))
    throw Error('Invalid restricted document reviewer assignment state.');
  return data.rows;
}
function submitted(state,doc,edition){
  return state.audit.findLast(e=>e.action==='governance-documents.submit'&&e.entityId===doc&&e.details?.versionId===edition)?.id;
}
function assignment(state,doc,version){
  if(!version||version.status!=='review')return undefined;
  return records(state).find(row=>row.document===doc.id&&row.edition===version.id&&
    row.submission===submitted(state,doc.id,version.id));
}
function allowedType(doc,v){
  return doc?.kind==='policy'&&v?.status==='review'&&Array.isArray(v.links)&&!v.links.length&&
    (v.attachments===undefined||Array.isArray(v.attachments)&&!v.attachments.length);
}
function eligible(state,context){
  const member=context.roster.find(x=>x.id===context.configured&&x.role==='reviewer');
  if(!member||!valid(hash,member.provisioning)||member.configuredDisabled||
    (member.validUntil!==null&&context.at>=member.validUntil))return undefined;
  const generation=identity.record(state,member.id);
  return generation.disabled?undefined:{account:member.id,provisioning:member.provisioning,generation:generation.revision};
}
function canView(state,doc,version,context){
  if(!allowedType(doc,version))return false;
  const row=assignment(state,doc,version),member=eligible(state,context);
  return row&&member&&row.account===context.account&&row.account===member.account&&
    row.generation===member.generation&&row.provisioning===member.provisioning&&
    authorship.reviewStatus(state,doc,version,'reviewer',context.account)==='eligible';
}
function enforce(state,parts,context){
  if(!context||parts[0]!=='governance-documents')return;
  const doc=state.governanceDocuments?.documents.find(d=>d.id===parts[2]),version=doc?.revisions.find(v=>v.id===parts[4]);
  if(context.limited){
    if(parts.length!==6||!['read','return','publish'].includes(parts[5])||!canView(state,doc,version,context))missing();
  }else if(context.role==='reviewer'&&parts.length===6&&['return','publish'].includes(parts[5])&&doc&&assignment(state,doc,version))
    fail(409,'REVIEW_ASSIGNED_TO_ANOTHER_ACCOUNT','The named reviewer holds this submission. The analyst can clear the assignment.');
}
function update(state,context,docId,editionId,body,event){
  if(context.role!=='analyst')fail(403,'REVIEW_ASSIGNMENT_AUTHORITY','Only an analyst may assign document review.');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||!Object.hasOwn(body,'reviewer')||
    !Object.hasOwn(body,'expectedRevision')||!(body.reviewer===null||valid(accountPattern,body.reviewer))||
    !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)
    fail(422,'INVALID_REVIEW_ASSIGNMENT','Choose a named reviewer and a current document revision.');
  const book=state.governanceDocuments,doc=book?.documents.find(d=>d.id===docId),version=doc?.revisions.find(v=>v.id===editionId);
  if(!doc||!version||version.status!=='review')missing();
  if(book.revision!==body.expectedRevision)fail(409,'STALE_REVIEW_ASSIGNMENT','The document workspace changed. Reload before retrying.');
  const previous=assignment(state,doc,version),existing=records(state);
  const rows=existing.filter(row=>row.edition!==editionId);
  if(body.reviewer===null){
    if(!previous)missing();
  }else{
    const member=eligible(state,context),submission=submitted(state,docId,editionId);
    if(!allowedType(doc,version)||!submission||!member||member.account!==body.reviewer||
      authorship.reviewStatus(state,doc,version,'reviewer',body.reviewer)!=='eligible')
      fail(422,'REVIEWER_EDITION_INELIGIBLE','Only independently authored text-only policy editions are eligible for assignment.');
    if(previous&&previous.generation===member.generation&&previous.provisioning===member.provisioning)
      fail(409,'REVIEW_ASSIGNMENT_EXISTS','This exact review assignment already exists.');
    if(rows.length>=countLimit)fail(409,'REVIEW_ASSIGNMENT_LIMIT','This workspace has reached its active assignment limit.');
    rows.push({document:docId,edition:editionId,submission,...member});
  }
  state.documentReviewerAssignments={version:1,rows};
  book.revision++;
  if(!Number.isSafeInteger(book.revision))throw Error('Document workspace revision overflow.');
  event(state,'analyst',body.reviewer===null?'document-review-seat.cleared':'document-review-seat.assigned',null,docId,
    {edition:editionId,account:body.reviewer??previous.account,revision:book.revision,scope:'text-only-policy'});
}
function versionProjection(v){
  const {id,number,title,status,contentLength,contentHash}=v;
  return {id,number,title,status,contentLength,contentHash,links:[],attachments:[]};
}
function limitedModel(state,context){
  const old=state.governanceDocuments;
  return {restrictedDocumentReview:true,revision:old?.revision??0,targets:[],legacyRecords:[],
    documents:(old?.documents??[]).flatMap(doc=>{
      const revisions=doc.revisions.filter(v=>canView(state,doc,v,context)).map(versionProjection);
      return revisions.length?[{id:doc.id,kind:'policy',revisions}]:[];
    })};
}
function textProjection(result){
  return {id:result.id,kind:'policy',version:versionProjection(result.version),text:result.text};
}
function projection(state,model,context){
  if(!context)return model;
  const current=eligible(state,context);
  const mapped=model.documents.map(document=>{
    const source=state.governanceDocuments.documents.find(d=>d.id===document.id);
    return {...document,revisions:document.revisions.map(v=>{
      const version=source.revisions.find(row=>row.id===v.id),selected=assignment(state,source,version);
      if(context.role==='reviewer')return selected?{...v,publicationAuthority:'assigned'}:v;
      if(context.role!=='analyst')return v;
      const eligibleAccount=allowedType(source,version)&&current&&
        authorship.reviewStatus(state,source,version,'reviewer',current.account)==='eligible'?current.account:undefined;
      return {...v,...(selected?{reviewAssignee:selected.account}:{}),...(eligibleAccount?{reviewCandidate:eligibleAccount}:{})};
    })};
  });
  return {...model,documents:mapped};
}
function finish(state,edition){
  const rows=records(state);
  if(rows.some(row=>row.edition===edition))state.documentReviewerAssignments={version:1,rows:rows.filter(row=>row.edition!==edition)};
}
module.exports={provision,primaryConfig,assignment,enforce,update,limitedModel,textProjection,projection,finish};
