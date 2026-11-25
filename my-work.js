'use strict';
const {createHash}=require('node:crypto');
const {view:queueView}=require('./work-queue');
const authorship=require('./document-provenance');
const reviewSeats=require('./document-review-seats');
const remediation=require('./audit-remediation');

const supportedRoles=new Set(['analyst','reviewer','case-operator']);
const taskToken='[a-f0-9]{64}';
const safeRef=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(value);
const error=(message,status)=>{throw Object.assign(new Error(message),{status});};
const localLabels={'audit-management':'Audit management','governance-docs':'Policies and documents'};
function localTasks(state,actor,account){
  const out=[];
  function add(view,record,action,label,owner){
    if(owner!==actor)return;
    out.push({id:view+':'+record.id+':'+action,workflow:view,owner,label,title:record.title,
      dueDate:null,timing:'no-date',destination:{view,recordId:record.id}});
  }
  for(const plan of state.auditManagement?.plans??[]){
    if(plan.status==='planned')add('audit-management',plan,'begin','Begin audit fieldwork','analyst');
    if(plan.status==='fieldwork'){
      const complete=plan.controls.every(c=>plan.assessments.some(a=>a.controlId===c.id));
      add('audit-management',plan,complete?'submit':'assess',complete?'Submit evidence for independent audit review':'Assess scoped audit controls','analyst');
    }
    if(plan.status==='in-review'&&!plan.contributors.includes(account))
      add('audit-management',plan,'review','Review and finalize audit independently','reviewer');
  }
  for(const doc of state.governanceDocuments?.documents??[]){
    const revision=doc.revisions.at(-1);
    if(!revision||authorship.reviewStatus(state,doc,revision,actor,account)!=='eligible')continue;
    if(revision.status==='draft')add('governance-docs',revision,'submit','Submit document draft',revision.authoredBy);
    if(revision.status==='review'&&revision.authoredBy!=='reviewer'&&!reviewSeats.assignment(state,doc,revision))
      add('governance-docs',revision,'review','Review document publication independently','reviewer');
  }
  return out;
}


// This general inbox retains one broad seat per role; restricted document reviewers use their assignment list instead.
// The verified role is the assigned seat, never a request-supplied owner selector.
function assigned(state,{space,actor,account,documentReviewer},allowedViews,asOf){
  if(documentReviewer||!space?.id||typeof account!=='string'||!supportedRoles.has(actor))error('My work is unavailable.',404);
  const queue=queueView(state,new URLSearchParams({owner:actor}),asOf);
  const allowed=new Set(allowedViews);
  const remediationTasks=allowed.has('audit-management')?remediation.personalWork(state,{actor,account,asOf:queue.asOf}):[];
  const rows=[...queue.tasks,...localTasks(state,actor,account),...remediationTasks].filter(task=>task.owner===actor&&allowed.has(task.destination.view)&&
      task.destination.view===task.workflow&&safeRef(task.destination.recordId)&&
      (task.workflow!=='assessments'||safeRef(task.destination.projectId)))
    .map(task=>{
      const {view,recordId,projectId}=task.destination;
      const link=createHash('sha256').update(JSON.stringify(['my-work-v1',space.id,account,actor,task.id])).digest('hex');
      return {
        list:{key:link,workflow:task.workflow,workflowName:queue.workflowLabels[task.workflow]??localLabels[task.workflow],
          actionLabel:task.label,recordLabel:task.title,dueDate:task.dueDate,timing:task.timing},
        destination:{view,recordId,...(projectId===undefined?{}:{projectId})}
      };
    });
  return {asOf:queue.asOf,rows};
}

function model(state,session,allowedViews,params,key,today){
  if([...params.keys()].length)error('My work does not support owner or other query parameters.',422);
  const {asOf,rows}=assigned(state,session,allowedViews,today);
  if(key===undefined)return {asOf,tasks:rows.map(row=>row.list)};
  const selected=rows.find(row=>row.list.key===key);
  if(!selected)error('Assigned work item not found.',404);
  return {destination:selected.destination};
}
module.exports={model,taskToken};
