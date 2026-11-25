'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {maxBytes:largePdfMaxBytes}=require('./attachment-binary-batch');
const attachments=require('./governance-document-attachments');
const evidenceHolds=require('./evidence-holds');
const evidenceDisposition=require('./evidence-disposition');
const authorship=require('./document-provenance');
const docsOf=s=>s.governanceDocuments??{revision:0,documents:[]};
const kinds=['policy','evidence'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const isId=value=>typeof value==='string'&&uuid.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const linkKinds={risk:'Risk',control:'Control','rights-case':'Rights case',incident:'Incident'};
function issue(status,code,message){throw Object.assign(new Error(message),{status,code})}
function required(x,label,max){
  if(typeof x!=='string'||!x.trim()||x.length>max||x.includes('\0'))issue(422,'INVALID_TEXT',label+' must contain 1 to '+max+' characters.');
  return x.trim();
}
function digest(content){return createHash('sha256').update(content).digest('hex')}
function verifyText(v){
  if(typeof v.content!=='string'||!v.content.trim()||v.content.length>5000||v.content.includes('\0')||
    Buffer.byteLength(v.content)!==v.contentLength||digest(v.content)!==v.contentHash)
    issue(409,'EDITION_UNAVAILABLE','Document text failed its integrity check.');
}
function candidates(s){
  return [
    ...(s.riskControls?.risks??[]).map(x=>({type:'risk',id:x.id,label:x.title})),
    ...(s.riskControls?.controls??[]).map(x=>({type:'control',id:x.id,label:x.title})),
    ...(s.rightsCases??[]).map(x=>({type:'rights-case',id:x.id,label:x.kind+' · '+x.id.slice(0,8),owner:x.owner})),
    ...(s.incidentCases??[]).map(x=>({type:'incident',id:x.id,label:x.title}))
  ];
}
function redactVersion(version,manualReview){
  const {content,attachments:rows,accountProvenance,...safe}=version;
  return {...safe,attachments:(rows??[]).map(row=>attachments.metadata(row,manualReview))};
}
function permitted(s,doc,v,actor){
  if(!s.actors.some(x=>x.id===actor))return false;
  if(actor==='analyst'||actor==='reviewer')return true;
  if(v.status!=='published')return false;
  return doc.kind==='policy'||(doc.kind==='evidence'&&v.links.length>0&&v.links.every(l=>l.type==='rights-case'&&s.rightsCases?.some(r=>r.id===l.id&&r.owner===actor)));
}
function view(s,actor,capabilities,account){
  if(!s.actors.some(x=>x.id===actor))issue(403,'ACTOR_REQUIRED','Select a known local demo identity.');
  const book=docsOf(s);
  const manualReview=attachments.queryPolicy(book);
  const administrator=actor==='analyst'||actor==='reviewer';
  const holds=administrator?evidenceHolds.byEdition(book):undefined;
  const rehearsals=administrator?evidenceDisposition.byEdition(s,book,account,holds):undefined;
  const documents=book.documents.map(doc=>{
    const revisions=doc.revisions.filter(v=>permitted(s,doc,v,actor)).map(v=>{
      const projection=redactVersion(v,manualReview),authority=authorship.reviewStatus(s,doc,v,actor,account);
      const editionKey=evidenceHolds.key(doc.id,v.id);
      const hold=holds?.get(editionKey),rehearsal=rehearsals?.get(editionKey);
      return {...projection,...(hold?{evidenceHold:hold}:{}),...(rehearsal?{evidenceRehearsal:rehearsal}:{}),
        ...(authority?{publicationAuthority:authority}:{})};
    });
    if(!revisions.length)return null;
    const currentRevisionId=revisions.findLast(v=>v.status==='published')?.id??null;
    return {...doc,revisions,currentRevisionId};
  }).filter(Boolean);
  const attachmentRules=manualReview?{...attachments.rules,manualReview:true,
    ...(capabilities?.largePdf===true&&actor==='analyst'?{largePdfMaxBytes}:{})}:attachments.rules;
  return {revision:administrator?book.revision:null,kinds,linkKinds,attachmentRules,documents,targets:administrator?candidates(s):[],
    ...(administrator?{evidenceHoldReasons:{titles:evidenceHolds.titles,actions:evidenceHolds.actions},
      evidenceRetentionRules:evidenceDisposition.choices(s)}:{}),
    legacyRecords:administrator?(s.moduleRecords??[]).filter(x=>x.moduleId==='policies'):[]};
}
function verifyLinks(s,kind,links,allowed){
  if(!Array.isArray(links)||links.length>10||kind==='evidence'&&links.length===0)
    issue(422,'LINKS_REQUIRED','Choose up to ten case links; evidence needs at least one.');
  if(!links.length)return;
  const valid=allowed??new Set(candidates(s).map(x=>x.type+':'+x.id));
  const used=new Set();
  for(const x of links){
    if(!object(x)||Object.keys(x).length!==2||!Object.hasOwn(x,'type')||!Object.hasOwn(x,'id')||
      typeof x.type!=='string'||typeof x.id!=='string'||!valid.has(x.type+':'+x.id))
      issue(422,'INVALID_LINK','Choose existing fictional records with their correct types.');
    if(used.has(x.type+':'+x.id))issue(409,'DUPLICATE_LINK','A linked record may appear only once.');
    used.add(x.type+':'+x.id);
  }
}
function versionFields(s,kind,body){
  const title=required(body.title,'Fictional title',120),content=required(body.content,'Fictional text',5000);
  const links=body.links;
  verifyLinks(s,kind,links);
  return {title,content,contentHash:digest(content),contentLength:Buffer.byteLength(content),links:structuredClone(links)};
}
const actionKeys={
  create:['kind','title','content','links'],revise:['title','content','links'],edit:['title','content','links'],
  submit:[],publish:['note'],return:['note'],read:[],download:[],
  'evidence-hold':['reason','holdId'],
  'evidence-disposition-preview':['scheduleId','scheduleVersion','asOf'],'evidence-disposition-rehearse':['previewId'],
  'attachment-upload':['filename','mediaType','data'],'attachment-upload-batch':['files'],'attachment-upload-binary':['files'],'attachment-review':['operation','sha256'],'attachment-remove':[],'attachment-download':[]
};
function change(s,parts,actor,body,event,_vendorAssessments,account,capabilities){
  const book=s.governanceDocuments??=docsOf(s);
  const manualReview=attachments.queryPolicy(book);
  const [,collection,docId,part,revId,operation,attachmentId,attachmentOperation]=parts;
  let action=parts.length===2?'create':parts.length===4&&part==='revise'?'revise':null;
  if(part==='revisions'){
    if(parts.length===6&&['edit','submit','publish','return','read','download'].includes(operation))action=operation;
    if(operation==='evidence-disposition'&&parts.length===7&&['preview','rehearse'].includes(attachmentId))
      action='evidence-disposition-'+attachmentId;
    if(operation==='evidence-hold'&&parts.length===7&&Object.hasOwn(evidenceHolds.actions,attachmentId))action='evidence-hold';
    if(operation==='attachments'&&parts.length===6)action='attachment-upload';
    if(operation==='attachments'&&parts.length===7&&attachmentId==='batch')action='attachment-upload-batch';
    if(operation==='attachments'&&parts.length===7&&attachmentId==='binary-batch')action='attachment-upload-binary';
    if(operation==='attachments'&&parts.length===8&&['download','remove','review'].includes(attachmentOperation))action='attachment-'+attachmentOperation;
  }
  if(collection!=='records'||!action)issue(404,'NOT_FOUND','Governance document action not found.');
  const doc=book.documents.find(x=>x.id===docId);
  const v=doc?.revisions.find(x=>x.id===revId);
  const audit=(kind,document,version,details)=>event(s,actor,'governance-documents.'+kind,null,document?.id??null,
    {versionId:version?.id??null,...details});
  try{
    if(Object.keys(body).some(k=>!['expectedRevision',...actionKeys[action]].includes(k)))issue(422,'UNKNOWN_FIELDS','Only structured text and record links are supported.');
    if(['read','download','attachment-download'].includes(action)){
      if(!doc||!v)issue(404,'RECORD_NOT_FOUND','That document revision was not found.');
      if(!permitted(s,doc,v,actor))issue(403,'DOCUMENT_READ_DENIED','This demo identity cannot access that revision.');
      if(action==='attachment-download'){
        const row=v.attachments?.find(x=>x.id===attachmentId);
        if(!row)issue(404,'ATTACHMENT_NOT_FOUND','Attachment not found in this document revision.');
        attachments.assertAvailable(row,manualReview);
        const result=attachments.download(row);
        audit(action,doc,v,{attachmentId:row.id,version:v.number});
        return result;
      }
      verifyText(v);
      audit(action,doc,v,{hash:v.contentHash,version:v.number});
      return {id:doc.id,kind:doc.kind,version:redactVersion(v,manualReview),text:v.content,filename:'synthetic-'+doc.kind+'-v'+v.number+'.txt'};
    }
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)issue(422,'REVISION_REQUIRED','Provide the current document workspace revision.');
    if(body.expectedRevision!==book.revision)issue(409,'STALE_REVISION','The document workspace changed. Reload before retrying.');
    if(action.startsWith('evidence-disposition-')){
      if(!doc||!v)issue(404,'RECORD_NOT_FOUND','That document revision was not found.');
      if(v.status!=='published')issue(409,'EVIDENCE_REHEARSAL_EDITION','Choose an exact published edition.');
      verifyText(v);
      verifyLinks(s,doc.kind,v.links);
      for(const row of v.attachments??[])attachments.verifyStored(row,manualReview);
      const auditDetails=evidenceDisposition.transition(s,book,doc,v,attachmentId,actor,account,body,new Date().toISOString());
      book.revision++;
      audit('evidence-disposition.'+attachmentId,doc,v,{...auditDetails,revision:book.revision});
      return;
    }
    if(action==='evidence-hold'){
      if(!doc||!v)issue(404,'RECORD_NOT_FOUND','That document revision was not found.');
      if(v.status!=='published')issue(409,'EVIDENCE_HOLD_EDITION','Holds can only be placed on an exact published edition.');
      verifyText(v);
      verifyLinks(s,doc.kind,v.links);
      for(const row of v.attachments??[])attachments.verifyStored(row,manualReview);
      const auditDetails=evidenceHolds.transition(book,doc,v,attachmentId,actor,account,body,new Date().toISOString());
      book.revision++;
      audit('evidence-hold.'+attachmentId,doc,v,{...auditDetails,revision:book.revision});
      return;
    }
    const review=['publish','return'].includes(action);
    const attachmentReview=action==='attachment-review';
    const reviewer=review||attachmentReview;
    if(actor!==(reviewer?'reviewer':'analyst'))issue(403,reviewer?'INDEPENDENT_REVIEW_REQUIRED':'AUTHOR_REQUIRED',
      reviewer?'A separate demo reviewer must decide.':'Only the demo author can take this action.');
    if(account!==undefined&&!authorship.isAccount(account))issue(403,'DOCUMENT_ACCOUNT_REQUIRED','An authenticated local staff account is required.');
    const now=new Date().toISOString();
    let d=doc,row=v;
    if(action==='create'||action==='revise'){
      if(action==='create'){
        if(!kinds.includes(body.kind))issue(422,'INVALID_TYPE','Choose policy or evidence.');
        d={id:randomUUID(),kind:body.kind,createdAt:now,createdBy:actor,revisions:[]};
      }else{
        if(!d)issue(404,'RECORD_NOT_FOUND','Document not found.');
        if(d.revisions.at(-1).status!=='published')issue(409,'DRAFT_EXISTS','Finish the current revision before starting the next.');
      }
      row={id:randomUUID(),number:d.revisions.length+1,...versionFields(s,d.kind,body),status:'draft',authoredBy:actor,createdAt:now,
        attachments:[],updatedAt:now,publishedAt:null,publishedBy:null,reviewNote:null,
        ...(account!==undefined?{accountProvenance:authorship.start(account)}:{})};
      d.revisions.push(row);
      if(action==='create')book.documents.push(d);
    }else{
      if(!doc||!v)issue(404,'RECORD_NOT_FOUND','That document revision was not found.');
      if(v.status==='published')issue(409,'IMMUTABLE_REVISION','Published revisions cannot be changed.');
      if(v.status!==(review?'review':'draft'))issue(409,'OUT_OF_ORDER','This action is unavailable for the current revision stage.');
      const record=account!==undefined?authorship.acting(s,doc,v,actor,account,
        attachmentReview?'ATTACHMENT_INDEPENDENT_REVIEW':undefined):null;
      if(record&&!reviewer)authorship.contribute(record,account);
      if(attachmentReview){
        const target=v.attachments?.find(row=>row.id===attachmentId);
        if(!target)issue(404,'ATTACHMENT_NOT_FOUND','Attachment not found in this document revision.');
        const disposition=attachments.decide(target,manualReview,account,body);
        if(record)v.accountProvenance=record;
        book.revision++;v.updatedAt=now;
        audit(action,doc,v,{attachmentId:target.id,disposition,version:v.number,revision:book.revision});
        return;
      }
      if(action==='edit')Object.assign(v,versionFields(s,doc.kind,body));
      if(['attachment-upload','attachment-upload-batch','attachment-upload-binary'].includes(action)){
        const binary=action==='attachment-upload-binary';
        if(binary&&(!manualReview||capabilities?.largePdf!==true))
          issue(404,'ATTACHMENT_PROFILE_DISABLED','The larger PDF upload profile is unavailable.');
        const rows=action==='attachment-upload'?[attachments.attachment(body,book,v)]:attachments.batch(body.files,book,v,binary);
        (v.attachments??=[]).push(...(manualReview?rows.map(row=>attachments.stage(row,account)):rows));
        if(record)v.accountProvenance=record;
        book.revision++;v.updatedAt=now;
        for(const row of rows)audit('attachment-upload',doc,v,{attachmentId:row.id,version:v.number,revision:book.revision});
        return;
      }
      if(action==='attachment-remove'){
        const at=v.attachments?.findIndex(x=>x.id===attachmentId)??-1;
        if(at<0)issue(404,'ATTACHMENT_NOT_FOUND','Attachment not found in this document revision.');
        const [row]=v.attachments.splice(at,1);
        if(record)v.accountProvenance=record;
        book.revision++;v.updatedAt=now;
        audit(action,doc,v,{attachmentId:row.id,version:v.number,revision:book.revision});
        return;
      }
      if(['submit','publish'].includes(action)){
        verifyText(v);
        verifyLinks(s,doc.kind,v.links);
        for(const target of v.attachments??[])attachments.verifyStored(target,manualReview);
      }
      if(action==='submit'){
        v.status='review';v.reviewNote=null;
        if(record)record.submittedBy=account;
      }
      if(review){
        if(v.authoredBy===actor)issue(403,'INDEPENDENT_REVIEW_REQUIRED','The author cannot review the same revision.');
        const reviewNote=required(body.note,'Fictional review rationale',1000);
        v.reviewNote=reviewNote;
        if(action==='return'){
          v.status='draft';
          if(record)record.submittedBy=null;
        }else{
          Object.assign(v,{status:'published',publishedAt:now,publishedBy:actor});
          if(record)record.publishedBy=account;
        }
      }
      if(record)v.accountProvenance=record;
      v.updatedAt=now;
    }
    book.revision++;
    audit(action,d,row,{version:row.number,status:row.status,documentType:d.kind,hash:row.contentHash,linkIds:row.links,revision:book.revision});
  }catch(e){
    if(!e.status)throw e;
    audit('refused',doc,v,{action,code:e.code});
    throw Object.assign(e,{persistRefusal:true});
  }
}
function stateView(state){
  if(!state.governanceDocuments)return state;
  const {governanceDocuments,...safe}=state;
  return safe;
}
function policyEdition(state,document,edition){
  const doc=docsOf(state).documents.find(x=>x.kind==='policy'&&x.id===document);
  const v=doc?.revisions.find(x=>x.id===edition&&x.status==='published');
  if(!v)return null;
  verifyText(v);
  return {document:doc.id,edition:v.id,number:v.number,hash:v.contentHash,title:v.title,text:v.content};
}
function listPolicyEditions(state){
  return docsOf(state).documents.flatMap(doc=>doc.kind==='policy'?
    doc.revisions.filter(x=>x.status==='published').map(v=>({document:doc.id,edition:v.id,number:v.number,hash:v.contentHash,title:v.title})):[]);
}
function verifyEvidenceSnapshot(s){
  if(!Object.hasOwn(s,'governanceDocuments'))return;
  const bad=part=>{throw Error('Governance evidence integrity check failed ('+part+').');};
  const book=s.governanceDocuments;
  if(!object(book)||!Number.isSafeInteger(book.revision)||book.revision<0||!Array.isArray(book.documents))bad('document book');
  let manualReview;
  try{manualReview=attachments.queryPolicy(book);}catch{bad('attachment policy');}
  // Historical editions retain their original typed links. The linked domains
  // retain records across closure/archival, so a missing target is not valid.
  let targets;
  const docIds=new Set(),editionIds=new Set(),fileIds=new Set();
  let bytes=0;
  for(const doc of book.documents){
    if(!object(doc)||!isId(doc.id)||docIds.has(doc.id)||!kinds.includes(doc.kind)||
      !Array.isArray(doc.revisions)||!doc.revisions.length)bad('document identity');
    docIds.add(doc.id);
    for(const [index,v] of doc.revisions.entries()){
      if(!object(v)||!isId(v.id)||editionIds.has(v.id)||v.number!==index+1||
        !['draft','review','published'].includes(v.status)||(index<doc.revisions.length-1&&v.status!=='published'))
        bad('edition identity');
      editionIds.add(v.id);
      try{verifyText(v);}catch{bad('edition text');}
      try{
        if(v.links?.length&&!targets)targets=new Set(candidates(s).map(x=>x.type+':'+x.id));
        verifyLinks(s,doc.kind,v.links,targets);
      }catch{bad('typed links');}
      if(v.attachments===undefined)continue; // pre-attachment editions
      if(!Array.isArray(v.attachments)||v.attachments.length>attachments.rules.maxFilesPerRevision)bad('attachment count');
      for(const row of v.attachments){
        if(!object(row)||!isId(row.id)||fileIds.has(row.id)||!Number.isSafeInteger(row.size)||row.size<1)bad('attachment metadata');
        fileIds.add(row.id);bytes+=row.size;
        if(fileIds.size>attachments.rules.maxFilesPerWorkspace||bytes>attachments.rules.maxWorkspaceBytes)bad('attachment budget');
        try{attachments.verifyStored(row,manualReview,{draft:v.status==='draft'});}
        catch(error){bad(error.code==='ATTACHMENT_QUARANTINED'?'attachment quarantine':'attachment bytes');}
      }
    }
  }
  evidenceHolds.verify(book);
  evidenceDisposition.verify(s,book);
}
function enableManualReview(state){
  const book=docsOf(state);
  if(attachments.queryPolicy(book))return false;
  if(book.documents.some(d=>d.revisions.some(v=>v.attachments?.length)))
    throw Error('Manual attachment review needs a workspace with no existing attachments.');
  state.governanceDocuments={...book,attachmentReview:attachments.reviewPolicy};
  return true;
}
// Explicit local provisioning; there is deliberately no route to switch off a
// persisted quarantine policy or release staged files outside review.
function provisionReview(isolated){
  const selection=isolated?.attachmentReviewWorkspaces;
  if(selection===undefined)return new Set();
  if(!Array.isArray(selection)||!selection.length||new Set(selection).size!==selection.length||
    !Array.isArray(isolated.workspaces)||!Array.isArray(isolated.accounts))
    throw Error('Manual attachment review requires explicit isolated workspaces.');
  for(const id of selection){
    if(!isolated.workspaces.some(s=>s.id===id))throw Error('Manual attachment review workspace is unknown.');
    const author=isolated.accounts.find(a=>Object.hasOwn(a.memberships??{},id)&&a.memberships[id]==='analyst');
    const reviewer=isolated.accounts.find(a=>Object.hasOwn(a.memberships??{},id)&&a.memberships[id]==='reviewer');
    if(!author||!reviewer||author.id===reviewer.id)
      throw Error('Manual attachment review requires independent author and reviewer accounts.');
  }
  return new Set(selection);
}
module.exports={view,change,stateView,policyEdition,listPolicyEditions,enableManualReview,provisionReview,verifyEvidenceSnapshot};
