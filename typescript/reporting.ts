'use strict';
import type {RustCore,ReportFilters,ReportRow} from './contracts';
const rust:RustCore=require('./rust-core');
const {isCachedSnapshot}:{isCachedSnapshot(value:unknown):boolean}=require('./snapshot-reader');
interface AuditRecord {action?:unknown;entityId?:unknown;at?:unknown}
interface StatusRecord {status:string;createdAt?:unknown;openedAt?:unknown;receivedAt?:unknown}
interface ReportState {
  assessments?:readonly (StatusRecord&{id:string})[];
  handoff?:readonly (StatusRecord&{projectId:string})[];
  rightsCases?:readonly StatusRecord[];
  incidentCases?:readonly {stage:string;openedAt?:unknown}[];
  vendorMonitoring?:{cases?:readonly StatusRecord[]};
  privacyNotices?:{notices?:readonly StatusRecord[]};
  retentionBook?:{schedules?:readonly StatusRecord[]};
  governanceDocuments?:{documents?:readonly {createdAt?:unknown;revisions?:readonly StatusRecord[]}[]};
  auditManagement?:{plans?:readonly StatusRecord[]};
}
interface ReportModel {schemaVersion:number;mode:string;generatedAt:string;filters:ReportFilters;
  counts:{total:number;workflowCount:number;undated:number};rows:{key:string;label:string;count:number}[];
  options:Record<string,unknown>}
type Dataset=ReportFilters['dataset'];

// Reporting consumes only aggregate dimensions. Never copy source record fields,
// descriptions, names, identities, evidence, audit payloads, or request data.
const workflows=Object.freeze({
  assessments:'Assessments',handoff:'Project handoffs',rights:'Privacy rights',incidents:'Incidents',
  'vendor-monitoring':'Vendor monitoring','privacy-notices':'Privacy notices',retention:'Retention schedules',
  'governance-documents':'Policies and evidence','audit-management':'Audit management'
});
const stages=Object.freeze({
  draft:'Draft','in-review':'In review',approved:'Approved',rejected:'Returned',ready:'Ready',sent:'Sent',
  failed:'Failed',received:'Received','in-progress':'In progress',fulfilled:'Fulfilled',
  'closed-unverified':'Closed without verification',logged:'Logged',investigating:'Investigating',
  'notice-planning':'Notice planning','ready-to-close':'Ready to close',closed:'Closed',
  collecting:'Collecting',monitoring:'Monitoring',published:'Published',active:'Active',
  planned:'Planned',fieldwork:'Fieldwork',finalized:'Finalized',unknown:'Unknown'
});
const outcomes=Object.freeze({recorded:'Recorded',refused:'Refused',failed:'Failed'});
const groupings=Object.freeze({workflow:'Workflow',stage:'Current stage',outcome:'Event outcome',day:'UTC day',month:'UTC month'});
const allowedGroups=Object.freeze({records:['workflow','stage','day','month'],activity:['workflow','outcome','day','month']});
const activityWorkflows=new Map([
  ['assessment','assessments'],['handoff','handoff'],
  ['rights','rights'],['incident','incidents'],['vendor-monitoring','vendor-monitoring'],
  ['privacy-notices','privacy-notices'],['privacy-preferences','privacy-notices'],
  ['retention','retention'],['governance-documents','governance-documents'],['audit-management','audit-management']
]);
const stageAliases=new Map([['in_review','in-review'],['review','in-review']]);
const canReport=(role:string)=>role==='analyst'||role==='reviewer';
const own=(object:object,key:PropertyKey)=>Object.hasOwn(object,key);
const bad=(message:string):never=>{throw Object.assign(Error(message),{status:422,code:'INVALID_REPORT_FILTER'});};

function dayValue(value:unknown):string|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'0001-01-01')return null;
  const date=new Date(value+'T00:00:00Z');
  return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value?value:null;
}
function recordDay(value:unknown):string|null {
  if(typeof value!=='string'||!dayValue(value.slice(0,10)))return null;
  if(value.length===10)return value;
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  const date=new Date(value);
  return Number.isFinite(date.valueOf())?dayValue(date.toISOString().slice(0,10)):null;
}
function readFilters(params:URLSearchParams,exporting=false):{filters:ReportFilters;format:'json'|'csv'} {
  const supported=new Set(['dataset','workflow','stage','outcome','group','from','to',...(exporting?['format']:[])]);
  for(const key of new Set(params.keys()))if(!supported.has(key)||params.getAll(key).length!==1)bad('Use supported report filters only, and supply each once.');
  const dataset=params.get('dataset')??'records';
  if(dataset!=='records'&&dataset!=='activity')bad('Choose records or activity.');
  const workflow=params.get('workflow')??'all',stage=params.get('stage')??'all',outcome=params.get('outcome')??'all';
  const group=params.get('group')??'workflow',format=exporting?(params.get('format')??'json'):'json';
  if(workflow!=='all'&&!own(workflows,workflow))bad('Choose a supported workflow.');
  if(stage!=='all'&&(dataset!=='records'||!own(stages,stage)))bad('Choose a supported stage for workflow records.');
  if(outcome!=='all'&&(dataset!=='activity'||!own(outcomes,outcome)))bad('Choose a supported outcome for audit activity.');
  if(!allowedGroups[dataset].includes(group))bad('This grouping is not available for the selected dataset.');
  if(format!=='json'&&format!=='csv')bad('Export format must be JSON or CSV.');
  const dates:{from:string|null;to:string|null}={from:null,to:null};
  for(const key of ['from','to'] as const){
    const raw=params.get(key);
    dates[key]=raw===null?null:dayValue(raw);
    if(raw!==null&&!dates[key])bad('Enter a valid UTC calendar date in YYYY-MM-DD format.');
  }
  if(dates.from&&dates.to&&dates.from>dates.to)bad('The start date must be on or before the end date.');
  return {filters:{dataset,workflow,stage,outcome,group:group as ReportFilters['group'],...dates},format};
}

function *recordRows(state:ReportState,audit:readonly AuditRecord[]):Generator<ReportRow> {
  const created=new Map<string,string|null>();
  for(const e of audit){
    if(e.action==='assessment.created'||e.action==='project.created')created.set(e.action.split('.')[0]+':'+e.entityId,recordDay(e.at));
  }
  const row=(workflow:string,stage:string,day:string|null):ReportRow=>{
    const normalized=stageAliases.get(stage)??stage;
    return {workflow,stage:own(stages,normalized)?normalized:'unknown',day};
  };
  for(const a of state.assessments??[])yield row('assessments',a.status,created.get('assessment:'+a.id)??null);
  for(const h of state.handoff??[])yield row('handoff',h.status,created.get('project:'+h.projectId)??null);
  for(const c of state.rightsCases??[])yield row('rights',c.status,recordDay(c.receivedAt));
  for(const i of state.incidentCases??[])yield row('incidents',i.stage,recordDay(i.openedAt));
  for(const v of state.vendorMonitoring?.cases??[])yield row('vendor-monitoring',v.status,recordDay(v.openedAt));
  for(const n of state.privacyNotices?.notices??[])yield row('privacy-notices',n.status,recordDay(n.createdAt));
  for(const r of state.retentionBook?.schedules??[])yield row('retention',r.status,recordDay(r.createdAt));
  for(const d of state.governanceDocuments?.documents??[]){
    const revision=d.revisions?.at(-1);
    if(revision)yield row('governance-documents',revision.status,recordDay(d.createdAt));
  }
  for(const p of state.auditManagement?.plans??[])yield row('audit-management',p.status,recordDay(p.createdAt));
}
function *activityRows(audit:readonly AuditRecord[]):Generator<ReportRow> {
  for(const event of audit){
    const action=event.action;
    if(typeof action!=='string')continue;
    if(action.startsWith('privacy-preferences.')&&!action.startsWith('privacy-preferences.notice.'))continue;
    if(action.startsWith('privacy-notices.')&&!action.startsWith('privacy-notices.notice.')&&action!=='privacy-notices.refused')continue;
    const workflow=activityWorkflows.get(action.split('.')[0]);
    if(workflow)yield {workflow,outcome:action.endsWith('.refused')?'refused':action.endsWith('.failed')?'failed':'recorded',day:recordDay(event.at)};
  }
}
// Cache only redacted dimensions for a branded, immutable committed snapshot.
// The separately filtered audit reference must also be immutable. Mutable
// drafts, caller-supplied audit slices, and backup/export verification bypass
// the index. No report response, role decision, or generated timestamp is cached.
type IndexedRows={all:readonly ReportRow[];byWorkflow:Map<string,ReportRow[]>};
const rowCache=new WeakMap<ReportState,{audit:readonly AuditRecord[];records?:IndexedRows;activity?:IndexedRows}>();
function sourceFor(state:ReportState,audit:readonly AuditRecord[],dataset:Dataset,workflow:string):Iterable<ReportRow>{
  const rows=()=>dataset==='records'?recordRows(state,audit):activityRows(audit);
  if(!isCachedSnapshot(state)||!Object.isFrozen(audit))return rows();
  let cache=rowCache.get(state);
  if(!cache||cache.audit!==audit){cache={audit};rowCache.set(state,cache);}
  let index=cache[dataset];
  if(!index){
    const all=Array.from(rows()),byWorkflow=new Map<string,ReportRow[]>();
    for(const row of all){
      const group=byWorkflow.get(row.workflow);
      if(group)group.push(row);else byWorkflow.set(row.workflow,[row]);
    }
    index={all,byWorkflow};cache[dataset]=index;
  }
  return workflow==='all'?index.all:index.byWorkflow.get(workflow)??[];
}
function report(state:ReportState,audit:readonly AuditRecord[],params:URLSearchParams,{mode='synthetic-demo',exporting=false,generatedAt=new Date().toISOString()}={}):{model:ReportModel;format:'json'|'csv'} {
  const {filters,format}=readFilters(params,exporting);
  const {dataset,workflow,stage,outcome,group,from,to}=filters;
  const source=sourceFor(state,audit,dataset,workflow);
  let buckets:Map<string,number>,total=0,undated=0,workflowCount=0;
  if(rust.enabled){
    ({buckets,total,undated,workflowCount}=rust.aggregateReport(source,filters,{
      workflow:Object.keys(workflows),stage:Object.keys(stages),outcome:Object.keys(outcomes)
    }));
  }else{
    buckets=new Map<string,number>();const areas=new Set<string>();
    for(const item of source){
      if(workflow!=='all'&&item.workflow!==workflow||stage!=='all'&&item.stage!==stage||outcome!=='all'&&item.outcome!==outcome)continue;
      if(from&&(!item.day||item.day<from)||to&&(!item.day||item.day>to))continue;
      const key=group==='day'?(item.day??'undated'):group==='month'?(item.day?.slice(0,7)??'undated'):item[group];
      if(key===undefined)throw Error('Invalid report row dimension.');
      buckets.set(key,(buckets.get(key)??0)+1);
      areas.add(item.workflow);
      total++;
      if(!item.day)undated++;
    }
    workflowCount=areas.size;
  }
  const labels:Readonly<Record<string,string>>=group==='workflow'?workflows:group==='stage'?stages:group==='outcome'?outcomes:{undated:'Undated'};
  const rows=[...buckets].sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,count])=>({key,label:labels[key]??key,count}));
  const model:ReportModel={schemaVersion:1,mode,generatedAt,filters,counts:{total,workflowCount,undated},rows,
    options:{workflows,stages,outcomes,groupings,allowedGroups}};
  return {model,format};
}
function csvCell(value:unknown):string{
  let cell=String(value??'');
  // Keep actual values inert if spreadsheet applications interpret a leading marker.
  if(/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(cell))cell="'"+cell;
  return '"'+cell.replaceAll('"','""')+'"';
}
function csv(model:ReportModel):string{
  const f=model.filters;
  const header=['dataset','workflow_filter','stage_filter','outcome_filter','from_utc','to_utc','group_by','bucket','count'];
  return [header,...model.rows.map(r=>[f.dataset,f.workflow,f.stage,f.outcome,f.from,f.to,f.group,r.label,r.count])]
    .map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
export = {canReport,report,csv,csvCell};
