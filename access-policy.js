'use strict';

// HTTP-level authorization for signed-in local workspace accounts only.
// Per-record ownership, approval independence, and state-machine rules still live in the feature modules.
const operators=Object.freeze(['analyst','reviewer']);
const studio=Object.freeze([...operators,'publisher']);
const rights=Object.freeze([...operators,'case-operator']);
const all=Object.freeze([...rights,'publisher']);
const key='[a-zA-Z0-9][a-zA-Z0-9-]{0,127}';
const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const moduleId='(?:inventory|processing|rights|incidents|third-party|risks|controls|retention|policies|administration|integrations)';
const routes=[];
function route(method,value,roles){
  routes.push({method,path:new RegExp('^/api/'+value+'$'),roles});
}

// Specific methods and resource paths, never an open-ended workspace prefix.
route('GET','state',all);
route('GET','(?:vendor-monitoring|risk-controls|retention|privacy-notices|dictionary|dictionary/export|modules|work-queue|work-queue/export|reporting|reporting/export)',operators);
route('GET','(?:data-map|data-map/discovery|data-map/export|data-map/nodes/'+uuid+'/lineage)',operators);
route('GET','(?:risk-controls/export|incidents/cases|audit-management|audit-management/plans/'+uuid+'/report)',operators);
route('GET','(?:employee-attestations|trust-center)',operators);
route('GET','(?:rights/cases|governance-documents)',rights);
route('GET','audit/export',['reviewer']);
route('GET','workflows/(?:studio|definitions/'+key+'(?:/[1-9][0-9]*)?)',studio);
route('GET','workflows/(?:studio|instances)/'+key,operators);
route('GET','workflows/audit',['reviewer']);

route('POST','(?:projects|vendors|assessments/'+key+'/(?:save|submit|approve|reject)|handoff/'+key+'/(?:send|retry))',operators);
route('POST','rights/cases',operators);
route('POST','rights/cases/'+uuid+'/(?:assign|verify|deny-verification)',operators);
route('POST','rights/cases/'+uuid+'/(?:begin|fulfill|close-unverified)',rights);
route('POST','incidents/cases(?:/'+uuid+'/(?:triage|containment|evidence|findings|request-review|decide|plan-notice|close))?',operators);
route('POST','vendor-monitoring/cases(?:/'+uuid+'/(?:score|evidence|submit|approve|return|change|renew))?',operators);
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
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/attachments(?:/'+uuid+'/remove)?',operators);
route('POST','governance-documents/records/'+uuid+'/revisions/'+uuid+'/attachments/'+uuid+'/download',rights);
route('POST','trust-center/(?:privacy|rights|controls)/(?:draft|submit|approve|return|publish|withdraw)',operators);
route('POST','employee-attestations',operators);
route('POST','workflows/definitions',['publisher']);
route('POST','workflows/(?:instances|instances/'+key+'/transitions)',operators);

const views={
  analyst:['assessments','queue','rights','incidents','vendor-monitoring','data-map','dictionary','preferences','retention','governance-docs','employee-attestations','risk-controls','audit-management','workflow-studio','trust-center','report','modules'],
  reviewer:['assessments','queue','rights','incidents','vendor-monitoring','data-map','dictionary','preferences','retention','governance-docs','employee-attestations','risk-controls','audit-management','workflow-studio','trust-center','report','modules'],
  publisher:['workflow-studio'],
  'case-operator':['rights','governance-docs'],
};
const capabilities=role=>({views:[...(Object.hasOwn(views,role)?views[role]:[])],workspaceAudit:role==='reviewer'});
function requirePermission(method,pathname,role){
  const rule=routes.find(x=>x.method===method&&x.path.test(pathname));
  if(!rule)throw Object.assign(new Error('Not found.'),{status:404});
  if(!rule.roles.includes(role))throw Object.assign(new Error('This workspace role is not authorized for that action.'),{status:403,code:'ACCESS_DENIED'});
}

function operatorState(state,role){
  // Do not expose the workspace snapshot through /state or project/assessment mutation responses.
  const projectAccess=operators.includes(role);
  return {version:state.version,actors:[],projects:projectAccess?state.projects:[],vendors:projectAccess?state.vendors:[],
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
