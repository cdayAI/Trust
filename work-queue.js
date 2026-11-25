'use strict';
const workflowLabels={
  assessments:'Assessments',rights:'Privacy rights',incidents:'Incidents','vendor-monitoring':'Vendor monitoring',
  preferences:'Privacy notices',retention:'Retention','risk-controls':'Risk and controls'
};
function view(state,params,today=new Date().toISOString().slice(0,10)){
  const actors=state.actors.map(({id,name})=>({id,name:name??id}));
  for(const key of params.keys())if(!['owner','workflow','timing'].includes(key)||params.getAll(key).length!==1)
    invalid('Unsupported or repeated queue filter.');
  const filters={owner:params.get('owner')??'all',workflow:params.get('workflow')??'all',timing:params.get('timing')??'all'};
  if(filters.owner!=='all'&&!actors.some(x=>x.id===filters.owner))invalid('Unknown queue owner.');
  if(filters.workflow!=='all'&&!Object.hasOwn(workflowLabels,filters.workflow))invalid('Unknown workflow.');
  if(!['all','overdue','due-today','upcoming','no-date'].includes(filters.timing))invalid('Unknown timing filter.');

  const tasks=[];
  function task(workflow,record,action,label,owner,title,dueDate=null,extra={}){
    tasks.push({id:workflow+':'+record.id+':'+action,workflow,sourceId:record.id,action,label,owner,title,dueDate,
      timing:dueDate===null?'no-date':dueDate<today?'overdue':dueDate===today?'due-today':'upcoming',
      destination:{view:workflow,recordId:record.id,...extra}});
  }
  const vendors=new Map(state.vendors.map(v=>[v.id,v]));
  for(const a of state.assessments){
    const [action,label,owner]={
      draft:['submit','Complete assessment','analyst'],rejected:['resubmit','Revise returned assessment','analyst'],
      in_review:['review','Independently review assessment','reviewer']
    }[a.status]??[];
    if(action)task('assessments',a,action,label,owner,
      (vendors.get(a.vendorId)?.name??'Vendor')+' · '+(a.type==='ai'?'AI risk':'privacy')+(a.monitoringCycleId?' reassessment':' assessment'),
      null,{projectId:a.projectId});
  }
  for(const r of state.rightsCases??[]){
    if(r.closedAt)continue;
    if(r.identity.status==='pending')task('rights',r,'verify','Review identity independently','reviewer',r.kind+' request',r.dueDate);
    else if(r.identity.status==='not-verified')task('rights',r,'close-unverified','Decide no-disclosure closure',r.owner,r.kind+' request',r.dueDate);
    else if(r.status==='received')task('rights',r,'begin','Begin mock fulfillment',r.owner,r.kind+' request',r.dueDate);
    else if(r.status==='in-progress')task('rights',r,'fulfill','Document mock fulfillment',r.owner,r.kind+' request',r.dueDate);
  }
  for(const i of state.incidentCases??[]){
    const stage={logged:['triage','Triage severity'],investigating:['investigate','Record investigation and request review'],
      review:['decide','Review simulated notice decision'],'notice-planning':['plan','Record mock notice plan'],'ready-to-close':['close','Close incident']}[i.stage];
    if(stage)task('incidents',i,...stage,i.stage==='review'?'reviewer':i.owner,i.title);
  }
  for(const c of state.vendorMonitoring?.cases??[]){
    const title=vendors.get(c.vendorId)?.name??'Vendor';
    if(c.status==='collecting')task('vendor-monitoring',c,'collect','Collect cycle evidence and assessments',c.owner,title);
    else if(c.status==='review')task('vendor-monitoring',c,'review','Review vendor monitoring cycle','reviewer',title);
    else if(c.status==='monitoring')task('vendor-monitoring',c,'renew','Start renewal reassessment',c.owner,title,c.renewalDueDate);
  }
  for(const n of state.privacyNotices?.notices??[]){
    if(n.status==='draft')task('preferences',n,'submit','Submit notice draft',n.authoredBy,n.title);
    if(n.status==='review')task('preferences',n,'review','Review notice publication','reviewer',n.title);
  }
  for(const s of state.retentionBook?.schedules??[]){
    if(s.status==='draft')task('retention',s,'submit','Submit retention draft',s.authoredBy,s.title);
    if(s.status==='review')task('retention',s,'review','Review schedule activation','reviewer',s.title);
  }
  const controls=new Map((state.riskControls?.controls??[]).map(c=>[c.id,c]));
  const risks=new Map((state.riskControls?.risks??[]).map(r=>[r.id,r]));
  const latestTests=new Map((state.riskControls?.tests??[]).map(t=>[t.controlId,t]));
  for(const t of latestTests.values()){
    const c=controls.get(t.controlId);
    if(t.reviewStatus==='pending'&&c)task('risk-controls',c,'review-test-'+t.id,'Review latest control evidence','reviewer',c.title);
  }
  for(const l of state.riskControls?.links??[]){
    const r=risks.get(l.riskId);
    if(!l.reviewedBy&&!l.archivedAt&&r)task('risk-controls',r,'verify-link-'+l.id,'Review mitigation link','reviewer',r.title);
  }
  const rows=tasks.filter(t=>(filters.owner==='all'||t.owner===filters.owner)&&(filters.workflow==='all'||t.workflow===filters.workflow)&&
    (filters.timing==='all'||t.timing===filters.timing)).sort((a,b)=>
      (a.dueDate??'9999-12-31').localeCompare(b.dueDate??'9999-12-31')||a.workflow.localeCompare(b.workflow)||a.id.localeCompare(b.id));
  const counts={total:rows.length,overdue:rows.filter(x=>x.timing==='overdue').length,dueToday:rows.filter(x=>x.timing==='due-today').length,
    byWorkflow:Object.fromEntries(Object.keys(workflowLabels).map(k=>[k,rows.filter(x=>x.workflow===k).length]))};
  return {mode:'synthetic-demo',asOf:today,filters,counts,workflowLabels,actors,tasks:rows};
}
function invalid(message){throw Object.assign(new Error(message),{status:422,code:'INVALID_QUEUE_FILTER'})}
module.exports={view};
