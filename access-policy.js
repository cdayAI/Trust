'use strict';

// HTTP-level authorization for signed-in local workspace accounts only.
// Per-record ownership, approval independence, and state-machine rules still live in the feature modules.
const operators=Object.freeze(['analyst','reviewer']);
const studio=Object.freeze([...operators,'publisher']);
const rights=Object.freeze([...operators,'case-operator']);
const ethics=Object.freeze(['ethics-investigator','ethics-reviewer']);
const all=Object.freeze([...rights,'publisher','identity-admin',...ethics]);
const {taskToken:myWorkToken}=require('./my-work');
const key='[a-zA-Z0-9][a-zA-Z0-9-]{0,127}';
const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const moduleId='(?:inventory|processing|rights|incidents|third-party|risks|controls|retention|policies|administration|integrations)';
const routes=[];
function route(method,value,roles){
  routes.push({method,path:new RegExp('^/api/'+value+'$'),roles});
}

// Specific methods and resource paths, never an open-ended workspace prefix.
route('GET','operator/v1/jobs(?:/'+uuid+')?',operators);
route('POST','operator/v1/jobs(?:/'+uuid+'/run)?',operators);
route('POST','operator/v1/jobs/'+uuid+'/decision',['reviewer']);
route('POST','operator/v1/jobs/'+uuid+'/retry',['analyst']);
route('POST','operator/v1/jobs/'+uuid+'/reconcile',['reviewer']);
route('GET','state',all);
route('GET','workspace-home',rights);
route('GET','assessment-config',operators);
route('GET','reporting/runs(?:/'+uuid+'(?:/export)?)?',operators);
route('POST','reporting/runs',operators);
route('GET','processing-register(?:/export|/entries/'+uuid+'/versions/[1-9][0-9]*/export)?',operators);
route('POST','processing-register/entries(?:/'+uuid+'/(?:edit|submit|revise))?',['analyst']);
route('POST','processing-register/entries/'+uuid+'/(?:return|publish)',['reviewer']);
route('POST','assessment-config/(?:create|edit|submit)',['analyst']);
route('POST','assessment-config/(?:return|publish)',['reviewer']);
route('GET','my-work(?:/tasks/'+myWorkToken+')?',rights);
route('GET','identity-admin',['identity-admin']);
route('POST','identity-admin',['identity-admin']);
route('GET','group-governance',['identity-admin','reviewer']);
route('POST','group-governance',['identity-admin','reviewer']);
route('GET','scoped-applications',['analyst','case-operator']);
route('GET','document-access',['reviewer','identity-admin']);
route('POST','document-access',['reviewer','identity-admin']);
route('GET','(?:vendor-monitoring|risk-controls|retention|privacy-notices|dictionary|dictionary/export|modules|work-queue|work-queue/export|reporting|reporting/export)',operators);
route('GET','(?:data-map|data-map/discovery|data-map/export|data-map/nodes/'+uuid+'/lineage)',operators);
route('GET','(?:risk-controls/export|incidents/cases|audit-management|audit-management/plans/'+uuid+'/report)',operators);
route('GET','(?:employee-attestations|training|trust-center)',operators);
route('GET','maturity-planning(?:/plans/'+uuid+'/versions/[1-9][0-9]*/report)?',operators);
route('GET','(?:rights/cases|governance-documents)',rights);
route('GET','audit/export',['reviewer']);
route('GET','ethics/cases',ethics);
route('GET','ethics/cases/'+uuid+'/export',['ethics-reviewer']);
route('POST','ethics/cases(?:/'+uuid+'/(?:triage|begin|finding|submit))?',['ethics-investigator']);
route('POST','ethics/cases/'+uuid+'/(?:return|close)',['ethics-reviewer']);
route('GET','workflows/(?:studio|definitions/'+key+'(?:/[1-9][0-9]*)?)',studio);
route('GET','workflows/(?:studio|instances)/'+key,operators);
route('GET','workflows/audit',['reviewer']);

route('POST','assessments/'+key+'/linked-incident',['analyst']);
route('POST','(?:projects|vendors|assessments/'+key+'/(?:save|submit|approve|reject)|handoff/'+key+'/(?:send|retry))',operators);
route('GET','rights/deadline-policy',operators);
route('POST','rights/intake-form/(?:save|submit)',['analyst']);
route('POST','rights/intake-form/(?:return|publish)',['reviewer']);
route('POST','rights/deadline-policy/(?:draft|submit)',['analyst']);
route('POST','rights/deadline-policy/(?:return|publish)',['reviewer']);
route('POST','rights/cases/'+uuid+'/request-extension',['analyst','case-operator']);
route('POST','rights/cases/'+uuid+'/(?:approve-extension|reject-extension)',['reviewer']);
route('POST','rights/cases',operators);
route('POST','rights/cases/'+uuid+'/delegation',['analyst']);
route('POST','rights/cases/'+uuid+'/(?:assign|verify|deny-verification)',operators);
route('POST','rights/cases/'+uuid+'/(?:begin|fulfill|close-unverified)',rights);
route('POST','incidents/policy/(?:create|edit|submit)',['analyst']);
route('POST','incidents/policy/(?:return|publish)',['reviewer']);
route('POST','incidents/cases(?:/'+uuid+'/(?:triage|containment|evidence|findings|request-review|decide|plan-notice|close))?',operators);
route('POST','vendor-monitoring/cases(?:/'+uuid+'/(?:score|evidence|submit|approve|return|change|renew))?',operators);
route('POST','maturity-planning/plans(?:/'+uuid+'/(?:assess|submit|decide|return|approve|revise))?',operators);
route('GET','audit-management/remediations/'+uuid+'/report',operators);
route('POST','audit-management/remediations(?:/'+uuid+'/(?:plan|submit))?',['analyst']);
route('POST','audit-management/remediations/'+uuid+'/(?:return|close|reopen)',['reviewer']);
route('POST','audit-management/plans(?:/'+uuid+'/(?:begin|assess|submit|return|finalize))?',operators);
route('POST','risk-controls/(?:risks(?:/'+uuid+'/score)?|controls|links(?:/'+uuid+'/(?:unlink|verify))?|tests(?:/'+uuid+'/(?:accept|reject))?)',operators);
route('POST','retention/(?:schedules(?:/'+uuid+'/(?:edit|submit|activate|return))?|records|holds(?:/'+uuid+'/release)?|previews(?:/'+uuid+'/simulate)?)',operators);
route('POST','dictionary/terms(?:/'+uuid+'/(?:revise|submit|approve|return|retire|attach|detach))?',operators);
route('POST','privacy-notices/notices(?:/'+uuid+'/(?:edit|submit|return|publish))?',operators);
route('POST','data-map/(?:nodes(?:/'+uuid+'/(?:update|archive))?|links(?:/'+uuid+'/archive)?|discovery/(?:preview|apply))',operators);
route('POST','modules/'+moduleId+'/records(?:/'+uuid+'/(?:update|advance))?',operators);
route('POST','governance-documents/records(?:/'+uuid+'/revise)?',operators);
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/(?:edit|submit|publish|return)',operators);
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/(?:read|download)',rights);
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/attachments(?:/batch|/binary-batch|/'+uuid+'/remove)?',operators);
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/attachments/'+uuid+'/download',rights);
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/attachments/'+uuid+'/review',['reviewer']);
route('POST','trust-center/(?:privacy|rights|controls)/(?:draft|submit|approve|return|publish|withdraw)',operators);
route('POST','employee-attestations',operators);
route('POST','training/(?:create|edit|submit|return|publish|assign|reset)',operators);
route('POST','workflows/definitions',['publisher']);
route('POST','workflows/(?:instances|instances/'+key+'/transitions)',operators);

const views={
  analyst:['home','assessments','assessment-config','my-work','queue','rights','incidents','vendor-monitoring','data-map','processing-register','dictionary','preferences','retention','governance-docs','employee-attestations','training','risk-controls','audit-management','maturity-planning','workflow-studio','trust-center','report','modules'],
  reviewer:['home','assessments','assessment-config','my-work','queue','rights','incidents','vendor-monitoring','data-map','processing-register','dictionary','preferences','retention','governance-docs','employee-attestations','training','risk-controls','audit-management','maturity-planning','workflow-studio','trust-center','report','modules'],
  publisher:['workflow-studio'],
  'identity-admin':['identity-admin'],
  'ethics-investigator':['ethics'],
  'ethics-reviewer':['ethics'],
  'case-operator':['home','rights','my-work','governance-docs'],
};
function capabilities(role,{groupGovernance=false,documentScope=false,operatorJobs=false}={}){
  const permitted=[...(Object.hasOwn(views,role)?views[role]:[])];
  if(groupGovernance&&['identity-admin','reviewer'].includes(role))permitted.push('group-governance');
  if(groupGovernance&&['analyst','case-operator'].includes(role))permitted.push('scoped-applications');
  if(documentScope&&['reviewer','identity-admin'].includes(role))permitted.push('document-access');
  if(operatorJobs&&operators.includes(role))permitted.push('operator-jobs');
  return {views:permitted,workspaceAudit:role==='reviewer'};
}
function requirePermission(method,pathname,role){
  const rule=routes.find(x=>x.method===method&&x.path.test(pathname));
  if(!rule)throw Object.assign(new Error('Not found.'),{status:404});
  if(!rule.roles.includes(role))throw Object.assign(new Error('This workspace role is not authorized for that action.'),{status:403,code:'ACCESS_DENIED'});
}

function operatorState(state,role){
  // Do not expose the workspace snapshot through /state or project/assessment mutation responses.
  const projectAccess=operators.includes(role);
  const incidentLinks=projectAccess?(state.incidentCases??[]).flatMap(row=>row.assessmentOrigin?[{
    assessmentId:row.assessmentOrigin.assessmentId,assessmentRevision:row.assessmentOrigin.assessmentRevision,incidentId:row.id
  }]:[]):[];
  return {version:state.version,actors:[],projects:projectAccess?state.projects:[],vendors:projectAccess?state.vendors:[],
    ...(incidentLinks.length?{assessmentIncidentLinks:incidentLinks}:{}),
    assessments:projectAccess?state.assessments:[],handoff:projectAccess?state.handoff:[],
    audit:projectAccess?state.audit.filter(event=>typeof event.projectId==='string'&&
      /^(?:project|vendor|assessment|handoff)\./.test(event.action)):[]};
}

function caseOperatorView(model){
  return {...model,legacyRecords:[],cases:model.cases.filter(x=>x.owner==='case-operator')};
}

function caseDocumentView(model){
  const version=v=>{
    const {reviewNote,links,...rest}=v;
    return {...rest,links:[]};
  };
  if(Object.hasOwn(model,'version'))return {...model,version:version(model.version)};
  return {...model,documents:model.documents.map(doc=>({...doc,revisions:doc.revisions.map(version)}))};
}

function publisherStudio(model){
  return {mode:model.mode,actor:model.actor,recipes:model.recipes,definitions:model.definitions,
    instances:[],selected:null,recentAudit:model.recentAudit.filter(e=>typeof e.kind==='string'&&e.kind.startsWith('definition.'))};
}

module.exports={capabilities,requirePermission,operatorState,caseOperatorView,caseDocumentView,publisherStudio};
