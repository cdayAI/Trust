'use strict';

const {randomUUID}=require('node:crypto');
const channels=['web','mobile','connected-tv','service-desk'];
const prefs=s=>s.privacyNotices??{revision:0,notices:[]};
function error(status,code,message){throw Object.assign(new Error(message),{status,code})}
function text(value,label,max){
  if(typeof value!=='string'||!value.trim()||value.length>max)error(422,'FIELD_REQUIRED',label+' must contain 1 to '+max+' characters.');
  return value.trim();
}
function key(value,valid,label){
  if(!valid.includes(value))error(422,'INVALID_CHOICE','Select a valid '+label+'.');
  return value;
}
function only(body,allowed){
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!allowed.includes(k)))error(422,'UNKNOWN_FIELDS','Provide only the supported fields.');
}
function scope(value){
  if(typeof value!=='string'||!/^synthetic-[a-z0-9][a-z0-9-]{0,39}$/.test(value))error(422,'SYNTHETIC_SCOPE_REQUIRED','Use a fictional scope slug such as synthetic-portal.');
  return value;
}
function draftFields(body){
  return {title:text(body.title,'Fictional notice title',120),content:text(body.content,'Fictional notice text',4000)};
}
function view(state){
  const book=prefs(state), live=new Set();
  for(const n of book.notices)if(n.status==='published')live.add(n.scope+'|'+n.channel);
  return {revision:book.revision,channels,notices:book.notices.map(({purposes,...notice})=>notice),
    currentPairCount:live.size,legacyRecords:(state.moduleRecords??[]).filter(x=>x.moduleId==='policies')};
}
function change(state,parts,actor,body,event){
  const book=state.privacyNotices??=prefs(state);
  const [,collection,id,action]=parts;
  if(!(parts.length===2&&collection==='notices')&&
     !(parts.length===4&&collection==='notices'&&['edit','submit','return','publish'].includes(action)))error(404,'NOT_FOUND','Privacy notice action not found.');
  const row=collection==='notices'&&id?book.notices.find(n=>n.id===id):null;
  const now=new Date().toISOString();
  function record(kind,id,details){event(state,actor,'privacy-notices.'+kind,null,id,{...details,revision:book.revision})}
  try {
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)error(422,'REVISION_REQUIRED','Provide the current notice revision.');
    if(body.expectedRevision!==book.revision)error(409,'STALE_REVISION','The workspace changed. Reload before retrying.');
    let kind, target, details;
    if(parts.length===2&&collection==='notices'){
      if(actor!=='analyst')error(403,'AUTHOR_REQUIRED','Only the notice analyst can draft a revision.');
      only(body,['expectedRevision','scope','channel','title','content']);
      const s=scope(body.scope), channel=key(body.channel,channels,'channel');
      const peers=book.notices.filter(n=>n.scope===s&&n.channel===channel);
      if(peers.some(n=>n.status!=='published'))error(409,'DRAFT_EXISTS','Finish the existing draft for this scope and channel.');
      const notice={id:randomUUID(),scope:s,channel,version:(peers.at(-1)?.version??0)+1,
        ...draftFields(body),status:'draft',authoredBy:actor,createdAt:now,updatedAt:now,
        submittedAt:null,publishedAt:null,publishedBy:null,reviewNote:null};
      book.notices.push(notice);kind='notice.created';target=notice.id;details={scope:s,channel,version:notice.version};
    }else {
      if(!row)error(404,'NOTICE_NOT_FOUND','Notice revision not found.');
      if(row.status==='published')error(409,'NOTICE_IMMUTABLE','A published notice revision cannot be edited or unpublished.');
      if(['edit','submit'].includes(action)){
        if(actor!==row.authoredBy)error(403,'AUTHOR_REQUIRED','Only the notice author can edit or submit this revision.');
        if(row.status!=='draft')error(409,'OUT_OF_ORDER','Only a draft can be edited or submitted.');
      }else{
        if(actor!=='reviewer'||actor===row.authoredBy)error(403,'INDEPENDENT_REVIEW_REQUIRED','An independent reviewer must decide publication.');
        if(row.status!=='review')error(409,'OUT_OF_ORDER','Submit this draft before recording a decision.');
      }
      if(action==='edit'){
        only(body,['expectedRevision','title','content']);
        Object.assign(row,draftFields(body));
      }else if(action==='submit'){
        only(body,['expectedRevision']);
        row.status='review';row.submittedAt=now;row.reviewNote=null;
      }else{
        only(body,['expectedRevision','note']);
        row.reviewNote=text(body.note,'Fictional reviewer rationale',1000);
        if(action==='publish'){
          row.status='published';row.publishedBy=actor;row.publishedAt=now;
        }else row.status='draft';
      }
      row.updatedAt=now;kind='notice.'+action;target=row.id;
      details={scope:row.scope,channel:row.channel,version:row.version,status:row.status,reviewNote:row.reviewNote};
    }
    book.revision++;
    record(kind,target,details);
  }catch(e){
    if(!e.status)throw e;
    record('refused',row?.id??null,{collection,action:action??'create',code:e.code,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null});
    throw Object.assign(e,{persistRefusal:true});
  }
}
module.exports={view,change};
