'use strict';

const { createHash, randomUUID }=require('node:crypto');
const rubric=Object.freeze({
  version:1,maxLevel:4,
  levels:['Not established','Initial','Defined','Measured','Improving'],
  priority:['Critical at 9 or above','High at 5–8','Medium at 2–4','Low at 1']
});
const capabilities=Object.freeze([
  {id:'request-operations',label:'Privacy request operations',weight:4,owner:'Operations',
    guide:'Document intake and escalation; review deadline and fulfillment samples.'},
  {id:'incident-response',label:'Incident response',weight:4,owner:'Assurance',
    guide:'Run a tabletop and verify evidence, notification decisions, and closure criteria.'},
  {id:'supplier-assurance',label:'Supplier assurance',weight:3,owner:'Assurance',
    guide:'Define assessment gates, renewal triggers, and regular evidence checks.'},
  {id:'inventory-governance',label:'Inventory governance',weight:3,owner:'Governance',
    guide:'Assign inventory owners and reconcile a sample of mapped data movements.'},
  {id:'retention-operations',label:'Retention operations',weight:3,owner:'Operations',
    guide:'Review a schedule, verify legal-hold exceptions, and document simulated disposition.'},
  {id:'policy-governance',label:'Policy governance',weight:2,owner:'Governance',
    guide:'Publish reviewed policy revisions, track attestations, and review completion.'}
]);
const sources={synthetic:'Synthetic reference',audit:'Finalized audit report',policy:'Published policy revision',control:'Accepted passing control test'};
const actions={
  create:['title','scope','capabilityIds','targetDate'],
  assess:['expectedRevision','capability','baseline','target','evidenceType','evidenceReference','rationale','action','dueDate'],
  submit:['expectedRevision'],
  decide:['expectedRevision','capability','scoreId','decision','note'],
  return:['expectedRevision','note'],
  approve:['expectedRevision','note'],
  revise:['expectedRevision','targetDate']
};
const board=s=>s.maturityPlanning??{plans:[]};
const own=(x,k)=>Object.hasOwn(x,k);
const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(status,code,message){throw Object.assign(new Error(message),{status,code})}
function text(v,label,max){
  if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v))
    fail(422,'INVALID_TEXT',label+' is required and must be at most '+max+' characters.');
  return v.trim();
}
function date(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'0001-01-01')fail(422,'INVALID_DATE','Use a valid UTC calendar date.');
  const parsed=new Date(v+'T00:00:00Z');
  if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==v)fail(422,'INVALID_DATE','Use a valid UTC calendar date.');
  return v;
}
function level(n){
  if(!Number.isSafeInteger(n)||n<0||n>rubric.maxLevel)fail(422,'INVALID_LEVEL','Choose an integer maturity level from 0 to 4.');
  return n;
}
function evidenceOptions(state){
  return [
    ...(state.auditManagement?.plans??[]).filter(p=>p.final).map(p=>({type:'audit',id:p.id,label:p.title})),
    ...(state.governanceDocuments?.documents??[]).filter(d=>d.kind==='policy').flatMap(d=>d.revisions.filter(v=>v.status==='published')
      .map(v=>({type:'policy',id:v.id,label:v.title+' · revision '+v.number}))),
    ...(state.riskControls?.tests??[]).filter(t=>t.outcome==='pass'&&t.reviewStatus==='accepted').map(t=>{
      const control=state.riskControls.controls.find(c=>c.id===t.controlId);
      return {type:'control',id:t.id,label:(control?.title??'Control')+' · '+t.evidenceReference};
    })
  ];
}
function evidence(state,type,ref){
  if(typeof type!=='string'||!own(sources,type))fail(422,'INVALID_EVIDENCE','Choose an available evidence type.');
  if(type==='synthetic'){
    if(typeof ref!=='string'||!/^SYN-[A-Z0-9-]{3,35}$/.test(ref))fail(422,'INVALID_EVIDENCE','Use a fictional reference such as SYN-REVIEW-01.');
    return {type,reference:ref};
  }
  if(typeof ref!=='string'||!uuid.test(ref)||!evidenceOptions(state).some(x=>x.type===type&&x.id===ref))
    fail(422,'INVALID_EVIDENCE','Select eligible evidence linked to this workspace.');
  return {type,reference:ref};
}
function latestScore(version,key){
  return version.scores.findLast(row=>row.capability===key);
}
function latestDecision(version,scoreId){
  return version.decisions.findLast(row=>row.scoreId===scoreId);
}
function priorities(score){
  return score>=9?'critical':score>=5?'high':score>=2?'medium':'low';
}
function roadmap(plan,version){
  const rows=plan.capabilities.map(c=>{
    const entry=latestScore(version,c.id);
    return {id:c.id,label:c.label,weight:c.weight,owner:c.owner,guide:c.guide,assessment:entry??null,
      evidenceDecision:entry?latestDecision(version,entry.id)??null:null};
  });
  const assessed=rows.filter(r=>r.assessment);
  const weighted=key=>assessed.length===rows.length
    ?Math.round(10*assessed.reduce((n,r)=>n+r.assessment[key]*r.weight,0)/rows.reduce((n,r)=>n+r.weight,0))/10:null;
  const gaps=assessed.filter(r=>r.assessment.target>r.assessment.baseline).map(r=>{
    const {baseline,target,action,dueDate}=r.assessment;
    const gap=target-baseline,priorityScore=gap*r.weight;
    return {capability:r.id,label:r.label,owner:r.owner,gap,priorityScore,priority:priorities(priorityScore),action,dueDate,guide:r.guide};
  }).sort((a,b)=>b.priorityScore-a.priorityScore||a.dueDate.localeCompare(b.dueDate)||a.capability.localeCompare(b.capability));
  return {assessed:assessed.length,inScope:rows.length,accepted:rows.filter(r=>r.evidenceDecision?.decision==='accept').length,
    baseline:weighted('baseline'),target:weighted('target'),rows,gaps};
}
function view(state){
  return {rubric,capabilities,sources,evidenceOptions:evidenceOptions(state),plans:board(state).plans.map(p=>({
    ...p,versions:p.versions.map(v=>({...v,roadmap:v.final?.result.roadmap??roadmap(p,v)}))
  }))};
}
function lookup(state,id){
  return board(state).plans.find(p=>p.id===id)??fail(404,'PLAN_NOT_FOUND','Maturity plan not found.');
}
function report(state,id,number){
  const plan=lookup(state,id);
  const version=plan.versions.find(v=>v.number===number);
  if(!version)fail(404,'VERSION_NOT_FOUND','Maturity plan version not found.');
  if(!version.final)fail(409,'PLAN_NOT_APPROVED','Only reviewer-signed versions can be exported.');
  if(createHash('sha256').update(JSON.stringify(version.final.result)).digest('hex')!==version.final.sha256)
    fail(409,'PLAN_INTEGRITY_FAILED','The signed plan does not match its stored digest.');
  return {schemaVersion:1,mode:'synthetic-local',...version.final};
}
function change(state,parts,actor,body,event,_createAssessments,account){
  const [,collection,id,action]=parts;
  const op=parts.length===2?'create':action;
  if(collection!=='plans'||(parts.length!==2&&parts.length!==4)||!own(actions,op)||(parts.length===4&&op==='create'))
    fail(404,'MATURITY_ACTION_NOT_FOUND','Maturity action not found.');
  const registry=state.maturityPlanning??=board(state),identity=account??actor;
  const log=(kind,target,details)=>event(state,actor,'maturity-planning.'+kind,null,target,details);
  try {
    if(Object.keys(body).some(k=>!actions[op].includes(k)))fail(422,'UNKNOWN_FIELDS','Provide only supported maturity planning fields.');
    const reviewing=['decide','return','approve'].includes(op);
    if(actor!==(reviewing?'reviewer':'analyst'))
      fail(403,reviewing?'INDEPENDENT_REVIEW_REQUIRED':'ANALYST_REQUIRED',reviewing?'An independent reviewer must take this action.':'Only the planning analyst may take this action.');
    const now=new Date().toISOString();
    const startVersion=(number,targetDate)=>({number,targetDate,rubric:structuredClone(rubric),status:'draft',scores:[],decisions:[],reviews:[],contributors:[identity],createdAt:now,final:null});
    if(op==='create'){
      const {capabilityIds}=body;
      if(!Array.isArray(capabilityIds)||!capabilityIds.length||capabilityIds.length>capabilities.length||
        new Set(capabilityIds).size!==capabilityIds.length||capabilityIds.some(key=>!capabilities.some(c=>c.id===key)))
        fail(422,'INVALID_SCOPE','Choose distinct capabilities from the supported catalog.');
      const plan={id:randomUUID(),title:text(body.title,'Synthetic plan title',120),scope:text(body.scope,'Synthetic scope',1000),
        capabilities:capabilities.filter(c=>capabilityIds.includes(c.id)).map(c=>({...c})),revision:1,createdBy:identity,
        createdAt:now,versions:[startVersion(1,date(body.targetDate))]};
      registry.plans.push(plan);
      log('created',plan.id,{revision:1,version:1,capabilities:capabilityIds});
      return;
    }
    const plan=lookup(state,id),version=plan.versions.at(-1);
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)fail(422,'REVISION_REQUIRED','Provide the current plan revision.');
    if(body.expectedRevision!==plan.revision)fail(409,'STALE_REVISION','The maturity plan changed. Reload before retrying.');
    if(reviewing&&version.contributors.includes(identity))fail(403,'INDEPENDENT_REVIEW_REQUIRED','A contributor may not review their own version.');
    const allowed={assess:'draft',submit:'draft',decide:'in-review',return:'in-review',approve:'in-review',revise:'approved'}[op];
    if(version.status!==allowed)fail(409,'INVALID_PLAN_STATE','This action is unavailable in the current plan state.');
    let details={};
    if(op==='assess'){
      if(!plan.capabilities.some(c=>c.id===body.capability))fail(422,'CAPABILITY_OUTSIDE_SCOPE','Score only a capability in this plan scope.');
      const baseline=level(body.baseline),target=level(body.target);
      if(target<baseline)fail(422,'INVALID_TARGET','Target cannot be lower than the proposed baseline.');
      let action=null,dueDate=null;
      if(target>baseline){
        action=text(body.action,'Roadmap action',1000);
        dueDate=date(body.dueDate);
        if(dueDate>version.targetDate)fail(422,'AFTER_PLAN_TARGET','The roadmap due date cannot be after the version target date.');
      }else if(body.action||body.dueDate)fail(422,'UNEXPECTED_ACTION','Add a roadmap action only when a capability has a gap.');
      const source=evidence(state,body.evidenceType,body.evidenceReference);
      const prior=latestScore(version,body.capability);
      const row={id:randomUUID(),capability:body.capability,baseline,target,evidence:source,
        rationale:text(body.rationale,'Fictional scoring rationale',1000),action,dueDate,
        supersedes:prior?.id??null,recordedAt:now,recordedBy:identity};
      version.scores.push(row);details={capability:row.capability,scoreId:row.id,priorScoreId:row.supersedes};
    }else if(op==='submit'){
      if(plan.capabilities.some(c=>!latestScore(version,c.id)))fail(422,'INCOMPLETE_BASELINE','Score every capability in this version before review.');
      version.status='in-review';
    }else if(op==='decide'){
      const row=latestScore(version,body.capability);
      if(!row||row.id!==body.scoreId)fail(409,'STALE_SCORE','Review the current evidence for that capability.');
      if(!['accept','reject'].includes(body.decision))fail(422,'INVALID_DECISION','Choose Accept or Reject.');
      if(latestDecision(version,row.id))fail(409,'EVIDENCE_ALREADY_REVIEWED','That evidence already has an independent decision.');
      const decision={id:randomUUID(),scoreId:row.id,capability:row.capability,decision:body.decision,
        note:text(body.note,'Reviewer evidence rationale',1000),reviewedAt:now,reviewedBy:identity};
      version.decisions.push(decision);details={capability:row.capability,scoreId:row.id,decisionId:decision.id,decision:decision.decision};
    }else if(op==='return'||op==='approve'){
      const summary=roadmap(plan,version);
      if(op==='approve'&&summary.accepted!==summary.inScope)fail(422,'EVIDENCE_NOT_ACCEPTED','Every current assessment requires independent evidence acceptance.');
      const review={id:randomUUID(),decision:op==='return'?'returned':'approved',note:text(body.note,'Reviewer signoff rationale',1000),at:now,reviewer:identity};
      version.reviews.push(review);details={reviewId:review.id};
      version.status=op==='return'?'draft':'approved';
      if(op==='approve'){
        const result=structuredClone({planId:plan.id,title:plan.title,scope:plan.scope,version:version.number,targetDate:version.targetDate,rubric:version.rubric,
          roadmap:summary,assessmentHistory:version.scores,evidenceHistory:version.decisions,reviewHistory:version.reviews});
        version.final={result,sha256:createHash('sha256').update(JSON.stringify(result)).digest('hex')};
        details.sha256=version.final.sha256;
      }
    }else{
      plan.versions.push(startVersion(version.number+1,date(body.targetDate)));
      details={previousVersion:version.number};
    }
    if(!reviewing&&!version.contributors.includes(identity)&&op!=='revise')version.contributors.push(identity);
    plan.revision++;
    log(op,plan.id,{...details,revision:plan.revision,version:plan.versions.at(-1).number,status:plan.versions.at(-1).status});
  }catch(error){
    if(error.status){log('refused',id??null,{operation:op,code:error.code});error.persistRefusal=true;}
    throw error;
  }
}
module.exports={view,report,change};
