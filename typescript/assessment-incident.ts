'use strict';
import assessmentFlow = require('./assessment-workflow');
type Assessment=Parameters<typeof assessmentFlow.instanceFor>[1]&{
  projectId:string;type:string;routing:{workflowId:string;form?:string};questionnaire:{id:string;version:number}
};
interface Origin {assessmentId:string;assessmentRevision:number;projectId:string;questionnaireId:string;questionnaireVersion:number;
  workflowInstanceId:string;workflowDefinitionId:string;workflowDefinitionVersion:number;workflowRevision:number;approvalEventId:string}
interface AssessmentAudit {id:string;action:string;entityId:string;projectId:string;actor:string;account?:string;details:{revision?:number;workflowInstanceId?:string;workflowRevision?:number}}
type IncidentState=Parameters<typeof assessmentFlow.instanceFor>[0]&{assessments:Assessment[];audit:AssessmentAudit[];incidentCases?:{id:string;assessmentOrigin?:Origin}[]};
type Event=(...args:unknown[])=>unknown;
const incidentWorkflow:{openCase(state:IncidentState,actor:string,input:{title:string;scope:string},event:Event,account:string,origin:Origin):{id:string}}=require('./incident-workflow');
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}

const route=/^\/api\/assessments\/([a-zA-Z0-9][a-zA-Z0-9-]{0,127})\/linked-incident$/;
const typed=(assessment:Assessment)=>assessment.type==='privacy'&&
  (assessment.routing.form==='dpia'||assessment.questionnaire.id==='sensitive');
function fail(status:number,code:string,message:string):never{throw Object.assign(Error(message),{status,code});}
function open(state:IncidentState,context:{actor:string;account:string},id:string,body:unknown,appendEvent:Event){
  if(context.actor!=='analyst')fail(403,'ANALYST_REQUIRED','Only the authorized assessment analyst can log this follow-up.');
  if(!object(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'expectedRevision')||
      typeof body.expectedRevision!=='number'||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)
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
  const origin:Origin={assessmentId:source.id,assessmentRevision:source.revision,projectId:source.projectId,
    questionnaireId:source.questionnaire.id,questionnaireVersion:source.questionnaire.version,
    workflowInstanceId:instance.id,workflowDefinitionId:source.routing.workflowId,
    workflowDefinitionVersion:instance.definitionVersion,workflowRevision:instance.revision,approvalEventId:approval.id};
  const found=(state.incidentCases??[]).find(row=>row.assessmentOrigin?.assessmentId===origin.assessmentId&&
    row.assessmentOrigin.assessmentRevision===origin.assessmentRevision);
  if(found){
    const existing=found.assessmentOrigin;
    if(!existing||Object.keys(existing).length!==Object.keys(origin).length||
      (Object.keys(origin) as (keyof Origin)[]).some(key=>existing[key]!==origin[key]))
      fail(409,'ASSESSMENT_ORIGIN_INCONSISTENT','The linked incident does not match the stored approval provenance.');
    return {created:false,incidentId:found.id,origin:existing};
  }
  const row=incidentWorkflow.openCase(state,context.actor,{
    title:'Assessment follow-up · '+source.id.slice(0,8),
    scope:'Fictional issue linked from an approved enhanced privacy assessment. Triage scope and severity independently.'
  },appendEvent,context.account,origin);
  return {created:true,incidentId:row.id,origin};
}
export = {open,route};
