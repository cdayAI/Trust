'use strict';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {WorkQueueState,WorkQueueTask} from './contracts';
const {taskDate:incidentDueDate}:{taskDate(row:unknown):string|null}=require('./incident-policy');
const {pendingExtension}:{pendingExtension(row:unknown):unknown}=require('./rights-workflow');
type Cursor=[1,string,number,number];
const workflowLabels:Record<string,string>={
  assessments:'Assessments',rights:'Privacy rights',incidents:'Incidents','vendor-monitoring':'Vendor monitoring',
  preferences:'Privacy notices',retention:'Retention','risk-controls':'Risk and controls'
};
const assessmentActions:Record<string,[string,string,string]>={
  draft:['submit','Complete assessment','analyst'],rejected:['resubmit','Revise returned assessment','analyst'],
  in_review:['review','Independently review assessment','reviewer']
};
const incidentActions:Record<string,[string,string]>={
  logged:['triage','Triage severity'],investigating:['investigate','Record investigation and request review'],
  review:['decide','Review simulated notice decision'],'notice-planning':['plan','Record mock notice plan'],'ready-to-close':['close','Close incident']
};
const workflows=Object.keys(workflowLabels);
function view(state:WorkQueueState,params:URLSearchParams,today=new Date().toISOString().slice(0,10),mode='synthetic-demo'){
  const actors=state.actors.map(({id,name})=>({id,name:name??id}));
  for(const key of params.keys())if(!['owner','workflow','timing'].includes(key)||params.getAll(key).length!==1)
    invalid('Unsupported or repeated queue filter.');
  const filters={owner:params.get('owner')??'all',workflow:params.get('workflow')??'all',timing:params.get('timing')??'all'};
  if(filters.owner!=='all'&&!actors.some(x=>x.id===filters.owner))invalid('Unknown queue owner.');
  if(filters.workflow!=='all'&&!Object.hasOwn(workflowLabels,filters.workflow))invalid('Unknown workflow.');
  if(!['all','overdue','due-today','upcoming','no-date'].includes(filters.timing))invalid('Unknown timing filter.');

  const tasks:WorkQueueTask[]=[];
  const counts={total:0,overdue:0,dueToday:0,byWorkflow:Object.fromEntries(workflows.map(key=>[key,0]))};
  const includes=(workflow:string)=>filters.workflow==='all'||filters.workflow===workflow;
  function task(workflow:string,record:{id:string},action:string,label:string,owner:string,title:string,dueDate:string|null=null,extra:{projectId?:string}={}){
    if(filters.owner!=='all'&&owner!==filters.owner)return;
    const timing=dueDate===null?'no-date':dueDate<today?'overdue':dueDate===today?'due-today':'upcoming';
    if(filters.timing!=='all'&&timing!==filters.timing)return;
    counts.total++;counts.byWorkflow[workflow]++;
    if(timing==='overdue')counts.overdue++;
    else if(timing==='due-today')counts.dueToday++;
    tasks.push({id:workflow+':'+record.id+':'+action,workflow,sourceId:record.id,action,label,owner,title,dueDate,timing,
      destination:{view:workflow,recordId:record.id,...extra}});
  }
  const vendors=includes('assessments')||includes('vendor-monitoring')?new Map(state.vendors.map(v=>[v.id,v])):null;
  if(includes('assessments'))for(const a of state.assessments){
    const [action,label,owner]=Object.hasOwn(assessmentActions,a.status)?assessmentActions[a.status]:[];
    if(action)task('assessments',a,action,label,owner,
      (vendors?.get(a.vendorId)?.name??'Vendor')+' · '+(a.type==='ai'?'AI risk':'privacy')+(a.monitoringCycleId?' reassessment':' assessment'),
      null,{projectId:a.projectId});
  }
  if(includes('rights'))for(const r of state.rightsCases??[]){
    if(r.closedAt)continue;
    const pending=pendingExtension(r);
    if(pending)task('rights',r,'review-extension','Review deadline extension','reviewer',r.kind+' request',r.dueDate);
    if(r.identity.status==='pending')task('rights',r,'verify','Review identity independently','reviewer',r.kind+' request',r.dueDate);
    else if(r.identity.status==='not-verified'){
      if(!pending)task('rights',r,'close-unverified','Decide no-disclosure closure',r.owner,r.kind+' request',r.dueDate);
    }else if(r.status==='received')task('rights',r,'begin','Begin mock fulfillment',r.owner,r.kind+' request',r.dueDate);
    else if(r.status==='in-progress'&&!pending)task('rights',r,'fulfill','Document mock fulfillment',r.owner,r.kind+' request',r.dueDate);
  }
  if(includes('incidents'))for(const i of state.incidentCases??[]){
    const stage=Object.hasOwn(incidentActions,i.stage)?incidentActions[i.stage]:null;
    if(stage)task('incidents',i,...stage,i.stage==='review'?'reviewer':i.owner,i.title,incidentDueDate(i));
  }
  if(includes('vendor-monitoring'))for(const c of state.vendorMonitoring?.cases??[]){
    const vendor=vendors?.get(c.vendorId)?.name??'Vendor';
    const title=c.engagement?vendor+' · '+c.engagement.title:vendor;
    if(c.status==='collecting')task('vendor-monitoring',c,'collect','Collect cycle evidence and assessments',c.owner,title);
    else if(c.status==='review')task('vendor-monitoring',c,'review','Review vendor monitoring cycle','reviewer',title);
    else if(c.status==='monitoring')task('vendor-monitoring',c,'renew','Start renewal reassessment',c.owner,title,c.renewalDueDate);
  }
  if(includes('preferences'))for(const n of state.privacyNotices?.notices??[]){
    if(n.status==='draft')task('preferences',n,'submit','Submit notice draft',n.authoredBy,n.title);
    if(n.status==='review')task('preferences',n,'review','Review notice publication','reviewer',n.title);
  }
  if(includes('retention'))for(const s of state.retentionBook?.schedules??[]){
    if(s.status==='draft')task('retention',s,'submit','Submit retention draft',s.authoredBy,s.title);
    if(s.status==='review')task('retention',s,'review','Review schedule activation','reviewer',s.title);
  }
  if(includes('risk-controls')){
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
  }
  tasks.sort((a,b)=>(a.dueDate??'9999-12-31').localeCompare(b.dueDate??'9999-12-31')||
    a.workflow.localeCompare(b.workflow)||a.id.localeCompare(b.id));
  return {mode,asOf:today,filters,counts,workflowLabels,actors,tasks};
}

function invalid(message:string):never{throw Object.assign(new Error(message),{status:422,code:'INVALID_QUEUE_FILTER'})}
function createPager(){
  const key=randomBytes(32);
  const signature=(data:string,scope:unknown)=>createHmac('sha256',key).update(JSON.stringify([scope,data])).digest();
  function conflict():never{throw Object.assign(new Error('The work queue changed. Start at the first page again.'),
    {status:409,code:'QUEUE_CURSOR_STALE'});}
  function pack(stamp:string,limit:number,start:number,scope:unknown):string{
    const data=Buffer.from(JSON.stringify([1,stamp,limit,start])).toString('base64url');
    return data+'.'+signature(data,scope).toString('base64url');
  }
  function unpack(token:unknown,scope:unknown):Cursor{
    if(typeof token!=='string'||token.length>256||!(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)))invalid('The queue cursor is malformed.');
    const [data,mac]=token.split('.'),provided=Buffer.from(mac,'base64url');
    if(provided.length!==32||provided.toString('base64url')!==mac||!timingSafeEqual(provided,signature(data,scope)))conflict();
    let payload:unknown;
    try{payload=JSON.parse(Buffer.from(data,'base64url').toString('utf8'));}catch{invalid('The queue cursor is malformed.');}
    if(!Array.isArray(payload)||payload.length!==4||payload[0]!==1||
      typeof payload[1]!=='string'||typeof payload[2]!=='number'||typeof payload[3]!=='number'||!Number.isSafeInteger(payload[2])||!Number.isSafeInteger(payload[3]))
      invalid('The queue cursor is malformed.');
    return [1,payload[1],payload[2],payload[3]];
  }
  return function page(state:WorkQueueState,params:URLSearchParams,scope:unknown,today?:string,mode?:string){
    if(!params.has('limit')&&!params.has('cursor'))return view(state,params,today,mode);
    if(params.getAll('limit').length!==1||params.getAll('cursor').length>1||
      !/^(?:[1-9][0-9]?|100)$/u.test(params.get('limit')??''))invalid('Use one queue page limit between 1 and 100.');
    const filters=new URLSearchParams(params),limit=Number(params.get('limit'));
    filters.delete('limit');filters.delete('cursor');
    const token=params.has('cursor')?unpack(params.get('cursor'),scope):null;
    const model=view(state,filters,today,mode),total=model.tasks.length;
    // Fingerprint exactly this filtered, ordered projection and UTC date.
    // Counts stay global to the filter and unrelated state changes do not
    // invalidate a cursor if they leave its visible projection unchanged.
    const stamp=createHash('sha256').update(JSON.stringify(model)).digest('base64url');
    const start=token?token[3]:0;
    if(token&&(stamp!==token[1]||limit!==token[2]||start<0||start>=total||start%limit!==0))conflict();
    const end=Math.min(start+limit,total);
    return {...model,tasks:model.tasks.slice(start,end),pagination:{
      limit,first:total?start+1:0,last:end,total,
      previousCursor:start?pack(stamp,limit,start-limit,scope):null,
      nextCursor:end<total?pack(stamp,limit,end,scope):null
    }};
  };
}
export = {view,createPager};
