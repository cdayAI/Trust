'use strict';

const {randomUUID}=require('node:crypto');
const deadlines=require('./rights-deadline-policy');
const {kinds}=deadlines;
const ownerIds=['analyst','case-operator'];
const backupActor={id:'case-operator',name:'Case Operator (demo)',role:'rights-operator'};
const policy={version:1,unit:'UTC calendar days',min:1,max:365,defaultDays:30};
const statuses=['received','in-progress','fulfilled','closed-unverified'];
function fail(status,code,message){throw Object.assign(new Error(message),{status,code});}
function choice(value,list,label){
  if(!list.includes(value))fail(422,'INVALID_CHOICE','Select a valid '+label+'.');
  return value;
}
function note(value){
  if(typeof value!=='string'||!value.trim()||value.length>1000){
    fail(422,'NOTE_REQUIRED','Provide a fictional case note of 1 to 1,000 characters.');
  }
  return value.trim();
}
function assertKeys(body, allowed) {
  if(Object.keys(body).some(k=>!allowed.includes(k)))fail(422,'UNKNOWN_FIELDS','The request contains unsupported fields.');
}

function view(state) {
  const cases=state.rightsCases??[];
  const today=new Date().toISOString().slice(0,10);
  const active=c=>!['fulfilled','closed-unverified'].includes(c.status);
  const historyByCase=new Map(cases.map(c=>[c.id,[]]));
  for(const e of state.audit)if(e.action.startsWith('rights.case.'))historyByCase.get(e.entityId)?.push(e);
  const owners=ownerIds.map(id=>state.actors.find(x=>x.id===id))
    .map((actor,i)=>({id:ownerIds[i],name:actor?.name??ownerIds[i]}));
  return {
    policy:{...policy,activeVersion:deadlines.active(state).version},kinds,owners,statuses,
    cases:cases.map(({extensionRequester,...c})=>({...c,overdue:active(c)&&c.dueDate<today,
      history:historyByCase.get(c.id)})),
    legacyRecords:(state.moduleRecords??[]).filter(r=>r.moduleId==='rights')
  };
}
function openCase(state,actor,{kind,owner,days,summary,source},event){
  const now=new Date().toISOString();
  const row={id:randomUUID(),kind,owner,summary,createdBy:actor,
    receivedAt:now,...deadlines.pin(state,kind,now,days),
    identity:{status:'pending',reviewedBy:null,reviewedAt:null},
    completion:null,closedAt:null,status:'received',updatedAt:now,revision:1};
  if(source)row.source=source;
  (state.rightsCases??=[]).push(row);
  event(state,actor,'rights.case.opened',null,row.id,{
    kind,owner,summary,dueDate:row.dueDate,clockPolicy:{...row.clockPolicy},revision:1,...(source?{source}:{})
  });
  return row;
}
function portalModel(state,grant,event,kind){
  const entries=state.requesterReceipts??[];
  const found=entries.find(x=>x.grantId===grant.id);
  let entry=found,row=entry?(state.rightsCases??[]).find(c=>c.id===entry.caseId):null,created=false;
  if(entry&&!row)throw Error('Unresolved synthetic receipt.');
  if(kind!==undefined){
    choice(kind,kinds,'request type');
    if(row&&row.kind!==kind)fail(409,'PORTAL_ALREADY_SUBMITTED','This synthetic code already has a request. Each code can submit only one.');
    if(!row){
      row=openCase(state,'synthetic-requester',{kind,owner:'analyst',
        summary:'Synthetic portal intake for '+grant.alias+'. No contact details or documents.',source:'synthetic-portal'},event);
      entry={grantId:grant.id,caseId:row.id,receipt:randomUUID()};
      (state.requesterReceipts??=[]).push(entry);
      event(state,'synthetic-requester','rights.case.portal-receipt-issued',null,row.id,{source:'synthetic-portal'});
      created=true;
    }
  }
  if(!row)return {created,value:{mode:'synthetic-requester',status:'not-submitted',requestTypes:kinds}};
  const publicStatus={received:'Received','in-progress':'In progress',fulfilled:'Simulation complete','closed-unverified':'Simulation closed without disclosure'};
  return {created,value:{mode:'synthetic-requester',status:publicStatus[row.status],requestType:row.kind,
    receivedDate:row.receivedAt.slice(0,10),receipt:entry.receipt}};
}
function change(state,parts,actor,body,event,_assessments,account) {
  if(parts.length===3&&parts[1]==='deadline-policy')return deadlines.mutate(state,actor,account,parts[2],body,event);
  const now=new Date().toISOString();
  const cases=state.rightsCases??[];
  if(parts.length===2&&parts[1]==='cases') {
    if(actor!=='analyst')fail(403,'INTAKE_REQUIRED','Only the intake analyst can open a case.');
    assertKeys(body,['kind','owner','days','note']);
    const kind=choice(body.kind,kinds,'request type'),owner=choice(body.owner,ownerIds,'case owner');
    if(body.days!==undefined&&(!Number.isSafeInteger(body.days)||body.days<policy.min||body.days>policy.max))fail(422,'INVALID_DEADLINE','Set a synthetic deadline of 1–365 calendar days.');
    openCase(state,actor,{kind,owner,days:body.days,summary:note(body.note)},event);
    return;
  }
  if(parts.length!==4||parts[1]!=='cases')fail(404,'NOT_FOUND','Rights endpoint not found.');
  const row=cases.find(c=>c.id===parts[2]);
  if(!row)fail(404,'NOT_FOUND','Rights case not found.');
  const action=parts[3];
  if(!['assign','verify','deny-verification','begin','fulfill','close-unverified','request-extension','approve-extension','reject-extension'].includes(action))fail(404,'NOT_FOUND','Rights action not found.');
  function refuse(status,code,message) {
    event(state,actor,'rights.case.refused',null,row.id,{requestedAction:action,code,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null,actualRevision:row.revision});
    throw Object.assign(new Error(message),{status,code,persistRefusal:true});
  }
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<=0)refuse(422,'REVISION_REQUIRED','Provide the current case revision.');
  if(body.expectedRevision!==row.revision)refuse(409,'STALE_REVISION','This case changed. Reload before retrying.');
  if(row.closedAt)refuse(409,'CASE_CLOSED','This case is closed.');
  const from=row.status;
  let details;
  if(['request-extension','approve-extension','reject-extension'].includes(action)){
    if(!account)return refuse(404,'EXTENSION_UNAVAILABLE','Extension review requires an isolated staff session.');
    const pending=row.extensionRequests?.find(request=>request.status==='pending');
    if(action==='request-extension'){
      if(actor!==row.owner)return refuse(403,'OWNER_REQUIRED','Only the assigned case owner can request an extension.');
      if(Object.keys(body).some(key=>!['expectedRevision','reason'].includes(key))||!deadlines.extensionReasons.includes(body.reason))
        return refuse(422,'INVALID_EXTENSION_REASON','Select a fictional extension reason.');
      if(!row.clockPolicy.extensionDays||pending||row.extensionRequests?.some(request=>request.status==='approved')||(row.extensionRequests?.length??0)>=3)
        return refuse(409,'EXTENSION_UNAVAILABLE','No further extension request is available under the pinned rule.');
      if(row.dueDate<now.slice(0,10))return refuse(409,'EXTENSION_EXPIRED','The pinned deadline has already passed.');
      const proposedDueDate=deadlines.addDays(row.originalDueDate,row.clockPolicy.extensionDays,
        row.clockPolicy.basis,row.clockPolicy.closedDates);
      (row.extensionRequests??=[]).push({status:'pending',reason:body.reason,proposedDueDate,requestedAt:now,requestedBy:actor});
      row.extensionRequester=account;
      details={reason:body.reason,proposedDueDate,dueDate:row.dueDate};
    }else{
      if(actor!=='reviewer'||actor===row.owner||row.extensionRequester===account)
        return refuse(403,'INDEPENDENT_REVIEW_REQUIRED','A different reviewer account must decide the extension.');
      if(Object.keys(body).some(key=>key!=='expectedRevision'))
        return refuse(422,'UNKNOWN_FIELDS','The request contains unsupported fields.');
      if(!pending)return refuse(409,'EXTENSION_NOT_PENDING','There is no pending extension request.');
      if(action==='approve-extension'&&row.dueDate<now.slice(0,10))
        return refuse(409,'EXTENSION_EXPIRED','The deadline passed while pending. Reject the extension to resolve review.');
      pending.status=action==='approve-extension'?'approved':'rejected';
      pending.reviewedAt=now;
      pending.reviewedBy=actor;
      delete row.extensionRequester;
      const previousDueDate=row.dueDate;
      if(pending.status==='approved')row.dueDate=pending.proposedDueDate;
      details={previousDueDate,dueDate:row.dueDate,decision:pending.status};
    }
    row.revision++;
    row.updatedAt=now;
    event(state,actor,'rights.case.'+action,null,row.id,{...details,from,to:row.status,revision:row.revision});
    return;
  }
  if(['fulfill','close-unverified'].includes(action)&&row.extensionRequests?.some(request=>request.status==='pending'))
    return refuse(409,'EXTENSION_PENDING','Resolve the pending extension before closing this case.');
  try {
    assertKeys(body,['expectedRevision','note',...(action==='assign'?['owner']:[])]);
    if(action==='assign'){
      if(actor!=='analyst')return refuse(403,'INTAKE_REQUIRED','Only the intake analyst can reassign a case.');
      const owner=choice(body.owner,ownerIds,'case owner');
      if(owner===row.owner)return refuse(409,'ALREADY_ASSIGNED','The case is already assigned to that owner.');
      details={note:note(body.note),previousOwner:row.owner,owner};
      row.owner=owner;
    } else if(action==='verify'||action==='deny-verification') {
      if(actor!=='reviewer'||actor===row.owner||actor===row.createdBy)return refuse(403,'INDEPENDENT_REVIEW_REQUIRED','An independent reviewer must decide identity verification.');
      if(row.status!=='received'||row.identity.status==='verified')return refuse(409,'IDENTITY_ALREADY_DECIDED','A verified or in-progress case cannot be verified again.');
      const status=action==='verify'?'verified':'not-verified';
      if(row.identity.status===status)return refuse(409,'IDENTITY_ALREADY_DECIDED','This identity decision is already recorded.');
      details={note:note(body.note),previousIdentity:row.identity.status,identity:status};
      row.identity={status,reviewedBy:actor,reviewedAt:now};
    } else {
      if(actor!==row.owner)return refuse(403,'OWNER_REQUIRED','Only the assigned case owner can take this action.');
      if(action==='close-unverified'){
        if(row.identity.status!=='not-verified'||row.status!=='received')return refuse(409,'DENIAL_REQUIRED','First record a failed independent identity review.');
        details={note:note(body.note),outcome:'no-disclosure'};
        row.status='closed-unverified';
        row.closedAt=now;
      }else {
        if(row.identity.status!=='verified')return refuse(409,'IDENTITY_REQUIRED','Verify identity independently before beginning or fulfilling the request.');
        const expected=action==='begin'?'received':'in-progress';
        if(row.status!==expected)return refuse(409,'ACTION_OUT_OF_ORDER','This action is not available at the current stage.');
        details={note:note(body.note)};
        if(action==='begin')row.status='in-progress';
        else {
          row.status='fulfilled';
          row.closedAt=now;
          row.completion={method:'simulation-only',releasedData:false,note:details.note,documentedBy:actor,documentedAt:now};
          details.method=row.completion.method;
          details.releasedData=false;
        }
      }
    }
  }catch(error){
    if(error.status&&!error.persistRefusal)return refuse(error.status,error.code,error.message);
    throw error;
  }
  row.revision++;
  row.updatedAt=now;
  event(state,actor,'rights.case.'+action,null,row.id,{...details,from,to:row.status,revision:row.revision});
}
module.exports={view,change,backupActor,portalModel};
