'use strict';

const {createHash,randomUUID}=require('node:crypto');
const holds=require('./evidence-holds');
const retention=require('./retention-workflow');
const version=1,limit=500;
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const accountPattern=/^[a-z][a-z0-9-]{0,47}$/u;
const shaPattern=/^[a-f0-9]{64}$/u;
const fits=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const hash=tuple=>createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
const ledger=book=>book.evidenceDisposition??{version,rows:[]};
const key=holds.key;
const scheduleBinding=rule=>hash(['evidence-retention-rule-v1',rule.id,rule.category,rule.version,rule.trigger,rule.days,rule.disposition,rule.activatedAt]);

function validRule(rule){
  return !!rule&&fits(idPattern,rule.id)&&Number.isSafeInteger(rule.version)&&rule.version>0&&
    Number.isSafeInteger(rule.days)&&rule.days>=1&&rule.days<=36500&&
    ['delete','archive','anonymize'].includes(rule.disposition)&&['created','closed'].includes(rule.trigger)&&iso(rule.activatedAt);
}
function choices(state){
  return retention.evidenceSchedules(state).filter(validRule).map(rule=>({
    id:rule.id,version:rule.version,category:rule.category,title:rule.title,trigger:rule.trigger,days:rule.days,disposition:rule.disposition
  }));
}
function compute(edition,rule,asOf){
  if(rule.trigger!=='created')fail(409,'EVIDENCE_TRIGGER_MISSING','No closure trigger is recorded for this published edition.');
  if(!iso(edition.createdAt))fail(409,'EVIDENCE_TRIGGER_MISSING','No verified creation timestamp is recorded for this edition.');
  const triggeredOn=retention.evidenceDate(edition.createdAt.slice(0,10));
  const dueOn=retention.afterDays(triggeredOn,rule.days);
  if(asOf<dueOn)fail(409,'EVIDENCE_NOT_DUE','The fictional as-of date is before the pinned rule’s due date.');
  return {triggeredOn,dueOn};
}

function verify(state,book){
  if(!Object.hasOwn(book,'evidenceDisposition'))return;
  const bad=()=>{throw Error('Governance evidence integrity check failed (disposition rehearsals).');};
  const value=book.evidenceDisposition;
  if(!object(value)||value.version!==version||!Array.isArray(value.rows)||value.rows.length>limit)bad();
  const editions=new Map(),scheduleCache=new Map(),ids=new Set(),outstanding=new Set(),completed=new Set();
  for(const doc of book.documents)for(const edition of doc.revisions)
    if(edition.status==='published')editions.set(key(doc.id,edition.id),{doc,edition});
  for(const row of value.rows){
    if(!object(row)||!fits(idPattern,row.id)||ids.has(row.id)||!fits(idPattern,row.scheduleId)||
      !fits(accountPattern,row.requestedBy)||!iso(row.requestedAt)||!fits(shaPattern,row.holdEpoch)||
      !['requested','superseded','rehearsed'].includes(row.status))bad();
    ids.add(row.id);
    const identity=key(row.document,row.edition),pin=editions.get(identity);
    let rule=scheduleCache.get(row.scheduleId);
    if(!rule){
      rule=retention.historicalEvidenceSchedule(state,row.scheduleId);
      if(!validRule(rule))bad();
      scheduleCache.set(row.scheduleId,rule);
    }
    if(!pin||row.evidenceBinding!==holds.editionBinding(pin.doc,pin.edition)||row.scheduleVersion!==rule.version||
      row.scheduleBinding!==scheduleBinding(rule)||row.disposition!==rule.disposition)bad();
    try{
      const dates=compute(pin.edition,rule,retention.evidenceDate(row.asOf));
      if(row.triggeredOn!==dates.triggeredOn||row.dueOn!==dates.dueOn)bad();
    }catch{bad();}
    if(row.status==='requested'){
      if(outstanding.has(identity))bad();
      outstanding.add(identity);
    }
    if(row.status==='rehearsed'){
      const completedId=identity+':'+row.scheduleId;
      const decision=row.decision;
      if(completed.has(completedId)||!object(decision)||!fits(idPattern,decision.id)||ids.has(decision.id)||
        !fits(accountPattern,decision.by)||decision.by===row.requestedBy||!iso(decision.at)||decision.at<row.requestedAt||
        decision.mode!=='audit-only'||decision.changedEvidence!==false||decision.deleted!==false)bad();
      ids.add(decision.id);completed.add(completedId);
    }else if(row.decision!==null)bad();
  }
}

function byEdition(state,book,account,currentHolds){
  verify(state,book);
  const projected=new Map();
  if(!ledger(book).rows.length)return projected;
  const currentRules=new Map(retention.evidenceSchedules(state).map(rule=>[rule.id,rule]));
  for(const row of ledger(book).rows){
    if(row.status==='superseded')continue;
    const editionKey=key(row.document,row.edition),activeRule=currentRules.get(row.scheduleId);
    const needsNewPreview=row.status==='requested'&&(!validRule(activeRule)||scheduleBinding(activeRule)!==row.scheduleBinding||
      hash([currentHolds.get(editionKey)??null])!==row.holdEpoch);
    projected.set(editionKey,{
      id:row.id,status:row.status,scheduleId:row.scheduleId,scheduleVersion:row.scheduleVersion,asOf:row.asOf,
      triggeredOn:row.triggeredOn,dueOn:row.dueOn,disposition:row.disposition,canReview:account!==row.requestedBy,needsNewPreview,
      ...(row.decision?{result:{id:row.decision.id,at:row.decision.at,mode:'audit-only',changedEvidence:false,deleted:false}}:{})
    });
  }
  return projected;
}

function transition(state,book,doc,edition,operation,role,account,body,now){
  if(!fits(accountPattern,account))fail(403,'EVIDENCE_REHEARSAL_IDENTITY','Sign in to an isolated staff account.');
  if(role!==(operation==='preview'?'analyst':'reviewer'))fail(403,'EVIDENCE_REHEARSAL_ROLE','This action requires the assigned independent role.');
  if(edition.status!=='published')fail(409,'EVIDENCE_REHEARSAL_EDITION','Choose an exact published edition.');
  verify(state,book);
  const identity=key(doc.id,edition.id);
  const lastHold=holds.byEdition(book).get(identity);
  if(lastHold&&lastHold.status!=='released')fail(409,'EVIDENCE_ACTIVE_HOLD','An outstanding hold blocks this evidence rehearsal.');
  const holdEpoch=hash([lastHold??null]);
  const evidenceBinding=holds.editionBinding(doc,edition);
  const data=ledger(book);
  const match=row=>row.document===doc.id&&row.edition===edition.id;
  const current=retention.evidenceSchedules(state);
  const ruleNow=id=>current.find(r=>r.id===id);
  const completed=id=>data.rows.some(row=>match(row)&&row.scheduleId===id&&row.status==='rehearsed');
  if(operation==='preview'){
    if(!fits(idPattern,body.scheduleId)||!Number.isSafeInteger(body.scheduleVersion)||body.scheduleVersion<1)
      fail(422,'EVIDENCE_RULE_REQUIRED','Choose a current fictional retention rule and its exact version.');
    const rule=ruleNow(body.scheduleId);
    if(!validRule(rule)||rule.version!==body.scheduleVersion)
      fail(409,'EVIDENCE_RULE_STALE','This retention rule is no longer current. Choose another version.');
    if(completed(rule.id))fail(409,'EVIDENCE_ALREADY_REHEARSED','This edition and rule version already have a rehearsal receipt.');
    if(data.rows.length>=limit)fail(409,'EVIDENCE_REHEARSAL_LIMIT','The workspace reached its local rehearsal history limit.');
    const asOf=retention.evidenceDate(body.asOf), dates=compute(edition,rule,asOf);
    const prior=data.rows.find(row=>match(row)&&row.status==='requested');
    if(prior)prior.status='superseded';
    const row={id:randomUUID(),document:doc.id,edition:edition.id,evidenceBinding,scheduleId:rule.id,scheduleVersion:rule.version,
      scheduleBinding:scheduleBinding(rule),holdEpoch,asOf,...dates,disposition:rule.disposition,
      requestedAt:now,requestedBy:account,status:'requested',decision:null};
    data.rows.push(row);
    book.evidenceDisposition=data;
    return {previewId:row.id,scheduleId:row.scheduleId,scheduleVersion:row.scheduleVersion,asOf,disposition:row.disposition,
      ...(prior?{supersedes:prior.id}:{})};
  }
  if(!fits(idPattern,body.previewId))fail(422,'EVIDENCE_PREVIEW_REQUIRED','Choose the exact rehearsal preview.');
  const row=data.rows.find(row=>match(row)&&row.id===body.previewId);
  if(!row)fail(404,'EVIDENCE_PREVIEW_NOT_FOUND','This preview does not belong to the selected edition.');
  if(row.status!=='requested'||completed(row.scheduleId))
    fail(409,'EVIDENCE_PREVIEW_CONFLICT','This preview was superseded or already rehearsed.');
  if(account===row.requestedBy)fail(403,'EVIDENCE_REHEARSAL_INDEPENDENCE','The preview author cannot approve this rehearsal.');
  const live=ruleNow(row.scheduleId);
  if(!validRule(live)||scheduleBinding(live)!==row.scheduleBinding||holdEpoch!==row.holdEpoch||evidenceBinding!==row.evidenceBinding)
    fail(409,'EVIDENCE_PREVIEW_STALE','Evidence, its hold history, or its retention rule changed. Create a new preview.');
  if(now<row.requestedAt)fail(409,'EVIDENCE_REHEARSAL_CLOCK','The local clock is earlier than the existing request.');
  const decision={id:randomUUID(),at:now,by:account,mode:'audit-only',changedEvidence:false,deleted:false};
  row.status='rehearsed';row.decision=decision;
  return {previewId:row.id,receiptId:decision.id,scheduleId:row.scheduleId,scheduleVersion:row.scheduleVersion,
    asOf:row.asOf,disposition:row.disposition,mode:decision.mode,changedEvidence:false,deleted:false};
}

module.exports={choices,verify,byEdition,transition};
