'use strict';
const {randomUUID}=require('node:crypto');
const severities=['low','moderate','high','critical'];
const decisions=['required','not-required','more-information'];
const noticeName={required:'required','not-required':'not required','more-information':'more information'};
const stages=['logged','investigating','review','notice-planning','ready-to-close','closed'];

function problem(status,code,message){throw Object.assign(new Error(message),{status,code})}
function text(value,label,max=1000){
  if(typeof value!=='string'||!value.trim()||value.length>max)problem(422,'FIELD_REQUIRED',label+' must contain 1 to '+max+' characters.');
  return value.trim();
}
function select(value,choices,label){
  if(!choices.includes(value))problem(422,'INVALID_CHOICE','Select a valid '+label+'.');
  return value;
}
function ref(value){
  if(typeof value!=='string'||!/^SYN-[A-Z0-9]{3,30}$/.test(value))problem(422,'INVALID_REFERENCE','Use a fictional evidence reference such as SYN-CASE01.');
  return value;
}
function keys(body,allowed) {
  if(Object.keys(body).some(x=>!allowed.includes(x)))problem(422,'UNKNOWN_FIELDS','The request contains unsupported fields.');
}
const elevated=row=>row.branch==='elevated';
function canReady(row){
  return Boolean(row.containment&&row.findings&&row.evidence.length>=(elevated(row)?2:1)&&
    (!elevated(row)||row.evidence.some(e=>e.kind==='impact'))&&
    (row.review?.decision!=='more-information'||row.lastInvestigationRevision>row.review.revision));
}
function view(state){
  const cases=state.incidentCases??[];
  const byCase=new Map(cases.map(row=>[row.id,[]]));
  for(const e of state.audit)if(e.action.startsWith('incident.case.'))byCase.get(e.entityId)?.push(e);
  return {severities,decisions,noticeName,stages,cases:cases.map(row=>({...row,history:byCase.get(row.id),readyForReview:canReady(row)})),
    legacyRecords:(state.moduleRecords??[]).filter(r=>r.moduleId==='incidents')};
}
const fields={
  triage:['severity','note'], containment:['note'], evidence:['reference','kind','note'], findings:['note'],
  'request-review':[], decide:['decision','note'], 'plan-notice':['reference','note'], close:['note']
};
function change(state,parts,actor,body,event){
  const cases=state.incidentCases??=[];
  const now=new Date().toISOString();
  if(parts.length===2&&parts[1]==='cases'){
    if(actor!=='analyst')problem(403,'OWNER_REQUIRED','Only the incident analyst can log an incident.');
    keys(body,['title','scope']);
    const row={id:randomUUID(),title:text(body.title,'Fictional title',120),scope:text(body.scope,'Fictional affected scope'),
      stage:'logged',owner:actor,severity:null,branch:null,containment:null,evidence:[],findings:null,review:null,noticePlan:null,
      closeNote:null,closedAt:null,openedAt:now,updatedAt:now,revision:1,lastInvestigationRevision:0};
    cases.push(row);
    event(state,actor,'incident.case.opened',null,row.id,{title:row.title,scope:row.scope,stage:row.stage,revision:1});
    return;
  }
  if(parts.length!==4||parts[1]!=='cases'||!Object.hasOwn(fields,parts[3]))problem(404,'NOT_FOUND','Incident action not found.');
  const row=cases.find(x=>x.id===parts[2]);
  if(!row)problem(404,'NOT_FOUND','Incident not found.');
  const action=parts[3];
  function refuse(status,code,message){
    event(state,actor,'incident.case.refused',null,row.id,{requestedAction:action,code,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null,actualRevision:row.revision});
    throw Object.assign(new Error(message),{status,code,persistRefusal:true});
  }
  const from=row.stage;
  let details;
  try{
    keys(body,['expectedRevision',...fields[action]]);
    if(!Number.isInteger(body.expectedRevision)||body.expectedRevision<1||!Number.isSafeInteger(body.expectedRevision))problem(422,'REVISION_REQUIRED','Provide the current incident revision.');
    if(body.expectedRevision!==row.revision)problem(409,'STALE_REVISION','This incident changed. Reload before retrying.');
    if(from==='closed')problem(409,'CASE_CLOSED','This incident is closed.');
    if(action==='decide'){
      if(actor!=='reviewer'||actor===row.owner)problem(403,'INDEPENDENT_REVIEW_REQUIRED','A separate reviewer must make the simulated notice decision.');
    }else if(actor!==row.owner)problem(403,'OWNER_REQUIRED','Only the incident owner may take this action.');
    function at(...allowed){
      if(!allowed.includes(from))problem(409,'OUT_OF_ORDER','This action is not available at the current stage.');
    }
    switch(action){
      case 'triage': {
        at('logged','investigating');
        const severity=select(body.severity,severities,'severity');
        const note=text(body.note,'Triage rationale');
        const branch=['high','critical'].includes(severity)?'elevated':'standard';
        details={severity,branch,previousSeverity:row.severity,note};
        Object.assign(row,{severity,branch,stage:'investigating'});
        break;
      }
      case 'containment': case 'findings':
        at('investigating');
        details={note:text(body.note,action==='containment'?'Containment note':'Investigation findings')};
        if(row[action]?.note===details.note)problem(409,'NO_CHANGE','Update the note before saving.');
        row[action]={note:details.note,at:now,by:actor};
        break;
      case 'evidence': {
        at('investigating');
        const reference=ref(body.reference);
        if(row.evidence.some(e=>e.reference===reference))problem(409,'EVIDENCE_EXISTS','That reference already exists.');
        if(row.evidence.length>=100)problem(409,'EVIDENCE_LIMIT','This incident already has 100 references.');
        details={reference,kind:select(body.kind,['general','impact'],'evidence type'),note:text(body.note,'Evidence note')};
        row.evidence.push({...details,at:now,by:actor});
        break;
      }
      case 'request-review':
        at('investigating');
        if(row.review?.decision==='more-information'&&row.lastInvestigationRevision<=row.review.revision)problem(409,'REVIEW_UPDATE_REQUIRED','Record updated containment, evidence or findings after the last review.');
        if(!canReady(row))problem(409,'INVESTIGATION_INCOMPLETE',elevated(row)?
          'Elevated incidents need containment, findings and two distinct evidence references, including an impact reference.':
          'Record containment, findings and at least one evidence reference before review.');
        details={branch:row.branch,evidenceCount:row.evidence.length};
        row.stage='review';
        break;
      case 'decide':
        at('review');
        details={decision:select(body.decision,decisions,'notice decision'),note:text(body.note,'Fictional reviewer rationale')};
        row.review={...details,by:actor,at:now,mode:'simulation-only',revision:row.revision+1};
        row.stage=details.decision==='more-information'?'investigating':details.decision==='required'?'notice-planning':'ready-to-close';
        break;
      case 'plan-notice':
        at('notice-planning');
        details={reference:ref(body.reference),note:text(body.note,'Mock notice plan'),sent:false};
        row.noticePlan={...details,at:now,by:actor};
        row.stage='ready-to-close';
        break;
      case 'close':
        at('ready-to-close');
        details={note:text(body.note,'Closure note'),reviewedBy:row.review.by,decision:row.review.decision,sent:false};
        row.stage='closed';row.closedAt=now;row.closeNote=details.note;
        break;
    }
  }catch(error){if(error.status)return refuse(error.status,error.code,error.message);throw error}
  row.revision++;
  if(['containment','findings','evidence'].includes(action))row.lastInvestigationRevision=row.revision;
  row.updatedAt=now;
  event(state,actor,'incident.case.'+action,null,row.id,{...details,from,to:row.stage,revision:row.revision});
}
module.exports={view,change};
