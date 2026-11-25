'use strict';
const assessmentFlow=require('./assessment-workflow');
const incidentWorkflow=require('./incident-workflow');

const route=/^\/api\/assessments\/([a-zA-Z0-9][a-zA-Z0-9-]{0,127})\/linked-incident$/;
const typed=assessment=>assessment.type==='privacy'&&
  (assessment.routing.form==='dpia'||assessment.questionnaire.id==='sensitive');
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
function open(state,context,id,body,appendEvent){
  if(context.actor!=='analyst')fail(403,'ANALYST_REQUIRED','Only the authorized assessment analyst can log this follow-up.');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'expectedRevision')||
      !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)
    fail(422,'ASSESSMENT_REVISION_REQUIRED','Provide the exact approved assessment revision only.');
  const source=state.assessments.find(row=>row.id===id);
  if(!source)fail(404,'ASSESSMENT_NOT_FOUND','Assessment not found.');
  if(!typed(source))fail(409,'ASSESSMENT_TYPE_REQUIRED','Only a DPIA or enhanced privacy assessment can open this follow-up.');
  if(source.revision!==body.expectedRevision)fail(409,'STALE_ASSESSMENT','The assessment changed. Reload the assessment before trying again.');
  const instance=assessmentFlow.instanceFor(state,source);
  const approval=state.audit.findLast(e=>e.action==='assessment.approved'&&e.entityId===source.id&&e.projectId===source.projectId&&
    e.actor==='reviewer'&&e.details.revision===source.revision&&e.details.workflowInstanceId===source.workflowInstanceId&&
    e.details.workflowRevision===source.workflowRevision);
  const submission=state.audit.findLast(e=>e.action==='assessment.submitted'&&e.entityId===source.id&&e.projectId===source.projectId&&
    e.actor==='analyst'&&e.details.revision===source.revision-1&&e.details.workflowInstanceId===source.workflowInstanceId);
  if(!assessmentFlow.isApproved(state,source)||instance.steps.at(-1)?.transitionId!=='approve'||
    !approval?.account||!submission?.account||approval.account===submission.account)
    fail(409,'APPROVED_ASSESSMENT_REQUIRED','An exact independently approved non-legacy assessment revision is required.');
  const origin={assessmentId:source.id,assessmentRevision:source.revision,projectId:source.projectId,
    questionnaireId:source.questionnaire.id,questionnaireVersion:source.questionnaire.version,
    workflowInstanceId:source.workflowInstanceId,workflowDefinitionId:source.routing.workflowId,
    workflowDefinitionVersion:source.workflowDefinitionVersion,workflowRevision:source.workflowRevision,approvalEventId:approval.id};
  const found=(state.incidentCases??[]).find(row=>row.assessmentOrigin?.assessmentId===origin.assessmentId&&
    row.assessmentOrigin.assessmentRevision===origin.assessmentRevision);
  if(found){
    if(Object.keys(found.assessmentOrigin).length!==Object.keys(origin).length||
      Object.entries(origin).some(([key,value])=>found.assessmentOrigin[key]!==value))
      fail(409,'ASSESSMENT_ORIGIN_INCONSISTENT','The linked incident does not match the stored approval provenance.');
    return {created:false,incidentId:found.id,origin:found.assessmentOrigin};
  }
  const row=incidentWorkflow.openCase(state,context.actor,{
    title:'Assessment follow-up · '+source.id.slice(0,8),
    scope:'Fictional issue linked from an approved enhanced privacy assessment. Triage scope and severity independently.'
  },appendEvent,context.account,origin);
  return {created:true,incidentId:row.id,origin};
}
module.exports={open,route};
