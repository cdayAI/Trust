'use strict';

const {createHash,randomUUID}=require('node:crypto');
const version=1, limit=500;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const account=/^[a-z][a-z0-9-]{0,47}$/u;
const is=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const titles=Object.freeze({
  'preservation-review':'Preservation review','audit-review':'Audit review','case-review':'Case review',
  'review-complete':'Review complete','hold-no-longer-needed':'Hold no longer needed','keep-preserving':'Keep preserving'
});
const actions=Object.freeze({
  place:['preservation-review','audit-review','case-review'],
  'request-release':['review-complete','hold-no-longer-needed'],
  'approve-release':['review-complete','hold-no-longer-needed'],
  'return-release':['keep-preserving']
});
const pending=row=>row.status!=='released';
const key=(document,edition)=>document+':'+edition;
const ledger=book=>book.evidenceHolds??{version,rows:[]};

function binding(doc,edition){
  return createHash('sha256').update(JSON.stringify([
    'evidence-hold-v1',doc.id,edition.id,edition.contentHash,edition.contentLength,edition.links,
    (edition.attachments??[]).map(row=>[row.id,row.sha256,row.size,row.mediaType])
  ])).digest('hex');
}
function stamp(value,reasons){
  return object(value)&&is(account,value.by)&&iso(value.at)&&reasons.includes(value.reason);
}
function verify(book){
  if(!Object.hasOwn(book,'evidenceHolds'))return;
  const value=book.evidenceHolds;
  const bad=()=>{throw Error('Governance evidence integrity check failed (retention holds).');};
  if(!object(value)||value.version!==version||!Array.isArray(value.rows)||value.rows.length>limit)bad();
  const editions=new Map(), ids=new Set(), live=new Set();
  for(const doc of book.documents)for(const edition of doc.revisions)
    if(edition.status==='published')editions.set(key(doc.id,edition.id),{doc,edition});
  for(const row of value.rows){
    if(!object(row)||!is(uuid,row.id)||ids.has(row.id)||!is(uuid,row.document)||!is(uuid,row.edition)||
      !['active','release-requested','released'].includes(row.status)||!stamp(row.placed,actions.place))bad();
    ids.add(row.id);
    const identity=key(row.document,row.edition),pin=editions.get(identity);
    if(!pin||row.binding!==binding(pin.doc,pin.edition)||pending(row)&&live.has(identity))bad();
    if(pending(row))live.add(identity);
    if(row.status==='active'){
      if(row.request!==null||row.release!==null)bad();
    }else{
      if(!stamp(row.request,actions['request-release'])||row.request.at<row.placed.at)bad();
      if(row.status==='release-requested'&&row.release!==null)bad();
      if(row.status==='released'&&(!stamp(row.release,actions['approve-release'])||
        row.release.by===row.placed.by||row.release.by===row.request.by||row.release.at<row.request.at))bad();
    }
  }
}
function byEdition(book){
  verify(book);
  const result=new Map();
  for(const row of ledger(book).rows){
    const ref=key(row.document,row.edition),last=result.get(ref);
    result.set(ref,{id:row.id,status:row.status,reason:row.placed.reason,placedAt:row.placed.at,
      requestedAt:row.request?.at??null,releasedAt:row.release?.at??null,historyCount:(last?.historyCount??0)+1});
  }
  return result;
}

function transition(book,doc,edition,operation,role,actor,body,now){
  if(!is(account,actor))fail(403,'EVIDENCE_HOLD_IDENTITY','Sign in to the isolated workspace to manage evidence holds.');
  if(edition.status!=='published')fail(409,'EVIDENCE_HOLD_EDITION','Holds can only be placed on an exact published edition.');
  const author=['place','request-release'].includes(operation);
  if(role!==(author?'analyst':'reviewer'))
    fail(403,'EVIDENCE_HOLD_AUTHORITY','This evidence hold action requires the assigned independent role.');
  if(!actions[operation].includes(body.reason)||(operation==='place'?Object.hasOwn(body,'holdId'):!is(uuid,body.holdId)))
    fail(422,'EVIDENCE_HOLD_FIELDS','Choose the current hold and a supported reason.');
  verify(book);
  const current=ledger(book);
  const match=row=>row.document===doc.id&&row.edition===edition.id;
  const stamp={at:now,by:actor,reason:body.reason};
  let row;
  if(operation==='place'){
    if(current.rows.some(row=>match(row)&&pending(row)))
      fail(409,'EVIDENCE_HOLD_EXISTS','This exact edition already has an outstanding hold.');
    if(current.rows.length>=limit)fail(409,'EVIDENCE_HOLD_LIMIT','The workspace reached its local evidence hold history limit.');
    row={id:randomUUID(),document:doc.id,edition:edition.id,binding:binding(doc,edition),
      status:'active',placed:stamp,request:null,release:null};
    current.rows.push(row);
    book.evidenceHolds=current;
  }else{
    row=current.rows.find(row=>match(row)&&row.id===body.holdId);
    if(!row)fail(404,'EVIDENCE_HOLD_NOT_FOUND','That hold was not found for the selected edition.');
    if(now<(row.request?.at??row.placed.at))fail(409,'EVIDENCE_HOLD_CLOCK','The local clock is earlier than the existing hold event.');
    if(operation==='request-release'){
      if(row.status!=='active')fail(409,'EVIDENCE_HOLD_ORDER','Only an active hold can enter release review.');
      row.status='release-requested';row.request=stamp;
    }else{
      if(row.status!=='release-requested')fail(409,'EVIDENCE_HOLD_ORDER','A pending release request is required.');
      if(actor===row.placed.by||actor===row.request.by)
        fail(403,'EVIDENCE_HOLD_INDEPENDENCE','The hold author or release requester cannot decide this request.');
      if(operation==='approve-release'){
        row.status='released';row.release=stamp;
      }else{
        row.status='active';row.request=null;
      }
    }
  }
  return {holdId:row.id,reason:body.reason,holdStatus:row.status};
}

module.exports={transition,verify,byEdition,titles,actions,key,editionBinding:binding};
