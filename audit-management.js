'use strict';
const {randomUUID,createHash}=require('node:crypto');
const remediation=require('./audit-remediation');
const board=s=>s.auditManagement??{plans:[]};
const outcomes=['effective','exception','inconclusive'];
const severities=['low','moderate','high','critical'];
const digest=result=>createHash('sha256').update(JSON.stringify(result)).digest('hex');
function error(status,code,details){throw Object.assign(new Error(details),{status,code})}
function text(value,label,max=1000){
  if(typeof value!=='string'||!value.trim()||value.length>max)error(422,'INVALID_FIELD',label+' must contain 1–'+max+' characters.');
  return value.trim();
}
function lookup(s,id){
  return board(s).plans.find(x=>x.id===id)??error(404,'AUDIT_NOT_FOUND','Audit plan not found.');
}
function view(s){
  return {plans:board(s).plans,remediation:remediation.view(s),controls:(s.riskControls?.controls??[]).map(({id,title,intent})=>({id,title,intent})),outcomes,severities};
}
function report(s,id){
  const plan=lookup(s,id);
  if(!plan.final)error(409,'AUDIT_NOT_FINAL','Only finalized audit reports can be exported.');
  return {schemaVersion:1,mode:'synthetic-local',result:plan.final.result,sha256:plan.final.sha256};
}
const actions={
  create:['title','objective','scope','controlIds'], begin:[], assess:['controlId','evidenceReference','outcome','observation','severity','correctiveAction'],
  submit:[], return:['note'], finalize:['note']
};
function change(state,parts,actor,body,event,_createAssessment,account=null){
  if(parts[1]==='remediations')return remediation.change(state,parts,actor,body,event,_createAssessment,account);
  const [,collection,id,operation]=parts;
  const op=parts.length===2?'create':operation;
  if(collection!=='plans'||![2,4].includes(parts.length)||!Object.hasOwn(actions,op)||(parts.length===4&&op==='create'))
    error(404,'AUDIT_ACTION_NOT_FOUND','Audit action not found.');
  const log=(action,target,details)=>event(state,actor,'audit-management.'+action,null,target,details);
  const actorIdentity=account??actor;
  const registry=state.auditManagement??=board(state);
  try{
    if(Object.keys(body).some(k=>![...actions[op],...(op==='create'?[]:['expectedRevision'])].includes(k)))error(422,'UNKNOWN_FIELDS','Provide only supported audit fields.');
    const reviewing=['return','finalize'].includes(op);
    if(actor!==(reviewing?'reviewer':'analyst'))
      error(403,reviewing?'INDEPENDENT_REVIEW_REQUIRED':'ANALYST_REQUIRED',reviewing?'An independent reviewer must take this action.':'Only the audit analyst may take this action.');
    const now=new Date().toISOString();
    if(op==='create'){
      if(!Array.isArray(body.controlIds)||body.controlIds.length<1||body.controlIds.length>20||
         body.controlIds.some(x=>typeof x!=='string')||new Set(body.controlIds).size!==body.controlIds.length)
        error(422,'INVALID_CONTROL_SCOPE','Select 1–20 distinct registered controls.');
      const controls=body.controlIds.map(controlId=>{
        const c=state.riskControls?.controls.find(x=>x.id===controlId);
        if(!c)error(422,'INVALID_CONTROL_SCOPE','Every scoped control must exist in this workspace.');
        return {id:c.id,title:c.title,intent:c.intent};
      });
      const plan={id:randomUUID(),title:text(body.title,'Synthetic audit title',120),objective:text(body.objective,'Audit objective'),
        scope:text(body.scope,'Scope and review period'),controls,createdAt:now,createdBy:actorIdentity,contributors:[actorIdentity],status:'planned',
        revision:1,assessments:[],reviews:[],final:null};
      registry.plans.push(plan);
      log('created',plan.id,{revision:plan.revision,controls:controls.map(x=>x.id)});
      return;
    }
    const plan=lookup(state,id);
    if(plan.final)error(409,'AUDIT_IMMUTABLE','Finalized plans and findings are immutable.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)error(422,'REVISION_REQUIRED','Provide the current audit plan revision.');
    if(body.expectedRevision!==plan.revision)error(409,'STALE_REVISION','The audit plan changed. Reload before retrying.');
    if(reviewing&&plan.contributors.includes(actorIdentity))error(403,'INDEPENDENT_REVIEW_REQUIRED','A contributor may not review their own audit.');
    const target={begin:'planned',assess:'fieldwork',submit:'fieldwork',return:'in-review',finalize:'in-review'}[op];
    if(plan.status!==target)error(409,'INVALID_AUDIT_STATE','This action is not available in the current audit status.');
    let details={};
    switch(op){
      case 'begin':
        plan.status='fieldwork';
        break;
      case 'assess': {
        const control=plan.controls.find(c=>c.id===body.controlId);
        if(!control)error(422,'CONTROL_OUTSIDE_SCOPE','Assess only a control in the locked audit scope.');
        const evidenceReference=body.evidenceReference;
        if(typeof evidenceReference!=='string'||!/^SYN-[A-Z0-9-]{3,35}$/.test(evidenceReference))error(422,'INVALID_EVIDENCE','Use a synthetic evidence identifier such as SYN-ACCESS-01.');
        const outcome=body.outcome;
        if(!outcomes.includes(outcome))error(422,'INVALID_OUTCOME','Choose a supported audit outcome.');
        const observation=text(body.observation,'Synthetic evidence observation');
        let finding=null;
        if(outcome==='exception'){
          if(!severities.includes(body.severity))error(422,'INVALID_SEVERITY','Choose a finding severity.');
          finding={id:randomUUID(),severity:body.severity,correctiveAction:text(body.correctiveAction,'Proposed corrective action')};
        }else if(body.severity||body.correctiveAction){
          error(422,'UNEXPECTED_FINDING','Only exceptions carry findings.');
        }
        const prior=plan.assessments.findLast(x=>x.controlId===control.id);
        const assessment={id:randomUUID(),controlId:control.id,outcome,evidenceReference,observation,finding,supersedes:prior?.id??null,
          recordedAt:now,recordedBy:actorIdentity};
        plan.assessments.push(assessment);
        details={controlId:control.id,assessmentId:assessment.id,findingId:finding?.id??null,outcome};
        break;
      }
      case 'submit': {
        const current=plan.controls.map(c=>plan.assessments.findLast(x=>x.controlId===c.id));
        if(current.some(x=>!x))error(422,'INCOMPLETE_COVERAGE','Record at least one evidence assessment for every scoped control.');
        plan.status='in-review';
        details={assessmentIds:current.map(x=>x.id)};
        break;
      }
      case 'return':
      case 'finalize': {
        const note=text(body.note,'Independent reviewer rationale');
        const review={id:randomUUID(),decision:op==='return'?'returned':'finalized',note,reviewer:actorIdentity,at:now};
        plan.reviews.push(review);
        plan.status=op==='return'?'fieldwork':'finalized';
        details={reviewId:review.id};
        if(op==='finalize'){
          const controls=plan.controls.map(c=>({control:c,assessment:plan.assessments.findLast(x=>x.controlId===c.id)}));
          const counts=Object.fromEntries(outcomes.map(o=>[o,controls.filter(x=>x.assessment.outcome===o).length]));
          const conclusion=counts.exception?'exceptions-found':counts.inconclusive?'inconclusive':'effective';
          const result=structuredClone({id:plan.id,title:plan.title,objective:plan.objective,scope:plan.scope,createdBy:plan.createdBy,
            assessmentHistory:plan.assessments,controls,counts,conclusion,reviewHistory:plan.reviews,finalizedRevision:plan.revision+1});
          plan.final={result,sha256:digest(result)};
          details.sha256=plan.final.sha256;
        }
        break;
      }
    }
    if(!reviewing&&!plan.contributors.includes(actorIdentity))plan.contributors.push(actorIdentity);
    plan.revision++;
    log(op,plan.id,{...details,revision:plan.revision,status:plan.status});
  }catch(e){
    if(e.status){log('refused',id??null,{operation:op,code:e.code});e.persistRefusal=true;}
    throw e;
  }
}
module.exports={view,change,report,remediationReport:remediation.report};
