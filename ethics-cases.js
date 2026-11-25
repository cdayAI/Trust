'use strict';

// All data is predefined and fictional. The service deliberately has no
// free-form intake, identity, credentials, uploads, or external delivery.
const {randomUUID}=require('node:crypto');
const investigator='ethics-investigator', reviewer='ethics-reviewer';
const categories={
  gift:'Gifts and hospitality',conflict:'Conflict of interest',
  records:'Records handling',supervision:'Supervisory conduct'
};
const urgency={routine:'Routine',priority:'Priority'};
const routes={standard:'Standard fact review',expedited:'Priority fact review'};
const outcomes={supported:'Supported in fictional scenario',not_supported:'Not supported in fictional scenario',
  inconclusive:'Inconclusive in fictional scenario'};
const evidence={fixture_review:'Review synthetic fixture',fixture_compare:'Compare synthetic fixtures',
  no_fixture:'No corroborating synthetic fixture'};
const disposition={
  remediation:'Recommend local process improvement',
  no_action:'Close without synthetic follow-up',
  unresolved:'Record unresolved synthetic review'
};
const returnReasons={
  evidence:'Add another synthetic evidence assessment',
  finding:'Clarify the finding outcome',
  disposition:'Reconsider the proposed disposition'
};
const statuses={intake:'Intake',triaged:'Triaged',investigating:'Investigation',review:'Closure review',closed:'Closed'};
const catalog={categories,urgency,routes,outcomes,evidence,disposition,returnReasons,statuses};
const record=s=>s.ethicsCases??{cases:[]};
const owns=(c,account)=>c.owner===account;
const reviewing=(c,account)=>['review','closed'].includes(c.status)&&!owns(c,account);
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
function choose(values,value,name){
  if(typeof value!=='string'||!Object.hasOwn(values,value))fail(422,'ETHICS_FIELD_INVALID','Select a valid '+name+'.');
  return value;
}
function shape(body,keys){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length||
    keys.some(key=>!Object.hasOwn(body,key)))
    fail(422,'ETHICS_FIELDS_INVALID','Use only the listed synthetic fields. Do not include personal details or files.');
}
function access(role,account){
  if(![investigator,reviewer].includes(role)||typeof account!=='string'||!account)
    fail(403,'ETHICS_ROLE_REQUIRED','A dedicated synthetic ethics role is required.');
}
const calendarDay=value=>value.slice(0,10);
function addEvent(c,action,role,details={}){
  c.timeline.push({action,role,revision:c.revision,day:calendarDay(new Date().toISOString()),...details});
}
function memberCase(state,id,role,account){
  const found=record(state).cases.find(x=>x.id===id);
  if(!found||!(role===investigator?owns(found,account):reviewing(found,account)))
    fail(404,'ETHICS_CASE_NOT_FOUND','Synthetic case not found.');
  return found;
}
function compatible(outcome,decision){
  return decision===({supported:'remediation',not_supported:'no_action',inconclusive:'unresolved'})[outcome];
}
function safeCase(c){
  const {owner,...rest}=c;
  return rest;
}
function view(state,role,account){
  access(role,account);
  const filtered=record(state).cases.filter(c=>role===investigator?owns(c,account):reviewing(c,account));
  return {catalog,role,cases:filtered.map(safeCase).reverse()};
}
function redactedExport(state,id,role,account){
  access(role,account);
  if(role!==reviewer)fail(403,'ETHICS_REVIEW_REQUIRED','Only the independent ethics reviewer can export a closed synthetic case.');
  const c=memberCase(state,id,role,account);
  if(c.status!=='closed')fail(409,'ETHICS_NOT_CLOSED','Only independently closed synthetic cases can be exported.');
  const v=c.findings.find(f=>f.version===c.review.findingVersion);
  return {schemaVersion:1,mode:'synthetic-ethics-redacted',caseReference:'ETH-'+c.number,category:c.category,urgency:c.urgency,
    disposition:c.review.disposition,findingOutcome:v.outcome,findingVersion:v.version,closedDay:c.review.closedDay,
    activity:c.timeline.map(({action,role,revision,day})=>({action,role,revision,day}))};
}
function change(state,role,account,action,id,body){
  access(role,account);
  const board=record(state);
  if(action==='open'){
    if(role!==investigator)fail(403,'ETHICS_INVESTIGATOR_REQUIRED','Only a synthetic investigator can open an intake.');
    shape(body,['category','urgency']);
    if(board.cases.length>=250)fail(409,'ETHICS_LIMIT','The synthetic case limit is reached.');
    const category=choose(categories,body.category,'category'),priority=choose(urgency,body.urgency,'priority');
    const c={id:randomUUID(),number:String(board.cases.length+1).padStart(4,'0'),owner:account,category,urgency:priority,
      status:'intake',route:null,revision:1,findings:[],returns:[],review:null,proposal:null,timeline:[]};
    addEvent(c,'opened',role);
    board.cases.push(c);state.ethicsCases=board;
    return {case:safeCase(c)};
  }
  const required={
    triage:['route'],begin:[],finding:['outcome','evidence'],submit:['findingVersion','disposition'],
    return:['reason'],close:[]
  };
  if(!Object.hasOwn(required,action))fail(404,'ETHICS_ROUTE_NOT_FOUND','Synthetic ethics action not found.');
  const needsReview=action==='return'||action==='close';
  if(role!==(needsReview?reviewer:investigator))
    fail(403,'ETHICS_ACTION_ROLE','This action belongs to another ethics role.');
  const c=memberCase(state,id,role,account);
  shape(body,['expectedRevision',...required[action]]);
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1||body.expectedRevision!==c.revision)
    fail(409,'ETHICS_REVISION_CONFLICT','The synthetic case changed. Reload before proceeding.');
  const starting={triage:'intake',begin:'triaged',finding:'investigating',submit:'investigating',return:'review',close:'review'};
  if(c.status!==starting[action])fail(409,'ETHICS_WRONG_STAGE','The requested action is not available at this stage.');
  if(c.timeline.length>=200)fail(409,'ETHICS_LIMIT','The synthetic case activity limit is reached.');
  let details={};
  switch(action){
    case 'triage':{
      const route=choose(routes,body.route,'review path');
      if(c.urgency==='priority'&&route!=='expedited')fail(422,'ETHICS_PRIORITY_PATH','Priority cases use priority fact review.');
      c.route=route;c.status='triaged';details={route};break;
    }
    case 'begin':c.status='investigating';break;
    case 'finding':{
      if(c.findings.length>=30)fail(409,'ETHICS_LIMIT','The synthetic finding version limit is reached.');
      const outcome=choose(outcomes,body.outcome,'finding outcome'),basis=choose(evidence,body.evidence,'evidence basis');
      if(basis==='no_fixture'&&outcome!=='inconclusive')
        fail(422,'ETHICS_EVIDENCE_REQUIRED','Without corroboration, the synthetic finding must be inconclusive.');
      const version=c.findings.length+1,candidate={version,outcome,evidence:basis};
      c.findings.push(candidate);details={findingVersion:version};break;
    }
    case 'submit':{
      const decision=choose(disposition,body.disposition,'disposition');
      const latest=c.findings.at(-1);
      if(!latest||latest.version!==body.findingVersion)
        fail(422,'ETHICS_LATEST_FINDING_REQUIRED','Select the current finding version.');
      if(c.returns.at(-1)?.findingVersion===latest.version)
        fail(422,'ETHICS_NEW_FINDING_REQUIRED','Record a new finding version after return.');
      if(!compatible(latest.outcome,decision))
        fail(422,'ETHICS_DISPOSITION_MISMATCH','The disposition does not match the current finding outcome.');
      c.proposal={findingVersion:latest.version,disposition:decision};
      c.status='review';details={findingVersion:latest.version};break;
    }
    case 'return':{
      const reason=choose(returnReasons,body.reason,'return reason');
      c.returns.push({findingVersion:c.proposal.findingVersion,reason});
      details={findingVersion:c.proposal.findingVersion};
      c.proposal=null;c.status='investigating';break;
    }
    case 'close':
      c.review={...c.proposal,closedDay:calendarDay(new Date().toISOString())};
      c.status='closed';details={findingVersion:c.review.findingVersion};break;
  }
  c.revision++;
  addEvent(c,action,role,details);
  return {case:safeCase(c)};
}
module.exports={view,change,redactedExport};
