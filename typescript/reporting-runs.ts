'use strict';
import {randomUUID} from 'node:crypto';
import reporting = require('./reporting');
type ReportState=Parameters<typeof reporting.report>[0];
type Audit=Parameters<typeof reporting.report>[1];
type ReportModel=ReturnType<typeof reporting.report>['model'];
interface SavedRun {
  id:string;generatedAt:string;expiresAt:string;filters:ReportModel['filters'];counts:ReportModel['counts'];json:string;csv:string;bytes:number;
}
interface RunState extends ReportState {reportRuns?:SavedRun[]}
function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
const routePattern=/^\/api\/reporting(?:\/export|\/(runs)(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(\/export)?)?)?$/;
const limits=Object.freeze({retentionDays:30,maxRuns:30,maxRunBytes:262144,maxWorkspaceBytes:1048576});
const ttl=limits.retentionDays*86400000;
const keys=['dataset','workflow','stage','outcome','group','from','to'];
function fail(status:number,code:string,message:string):never{throw Object.assign(Error(message),{status,code});}
function invalid(message:string):never{return fail(422,'INVALID_REPORT_RUN',message);}
const utf8=(value:string)=>Buffer.byteLength(value,'utf8');

function active(state:RunState,now:number):SavedRun[]{
  return (state.reportRuns??[]).filter(row=>Date.parse(row.expiresAt)>now);
}
function list(state:RunState,now=Date.now()){
  const rows=active(state,now);
  return {limits,runs:rows.slice().reverse().map(({id,generatedAt,expiresAt,filters,counts})=>({id,generatedAt,expiresAt,filters,counts}))};
}
function create(state:RunState,audit:Audit,body:unknown,mode:string,{now=Date.now()}={}):Buffer{
  if(!record(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'filters'))
    invalid('Provide only a filters object.');
  const {filters}=body;
  if(!record(filters)||Object.keys(filters).some(k=>!keys.includes(k)))
    invalid('Use supported report filters only.');
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(filters)){
    if((key==='from'||key==='to')&&value===null)continue;
    if(typeof value!=='string')invalid('Each report filter must be a string, or null for an unset date.');
    params.set(key,value);
  }
  const generatedAt=new Date(now).toISOString();
  const {model}=reporting.report(state,audit,params,{mode,generatedAt});
  const run={id:randomUUID(),expiresAt:new Date(now+ttl).toISOString()};
  const json=JSON.stringify({...model,run},null,2)+'\n', csv=reporting.csv(model);
  const bytes=utf8(json)+utf8(csv);
  if(bytes>limits.maxRunBytes)fail(413,'REPORT_RUN_TOO_LARGE','This report is too large to pin. Narrow the date range or choose a coarser grouping.');
  const held=active(state,now);
  const entry={...run,generatedAt,filters:model.filters,counts:model.counts,json,csv,bytes};
  held.push(entry);
  let totalBytes=held.reduce((total,row)=>total+row.bytes,0);
  while(held.length>limits.maxRuns||totalBytes>limits.maxWorkspaceBytes)totalBytes-=held.shift()!.bytes;
  state.reportRuns=held;
  return Buffer.from(json,'utf8');
}
function read(state:RunState,id:string,format:string,now=Date.now()):Buffer{
  const run=active(state,now).find(x=>x.id===id);
  if(!run)fail(404,'REPORT_RUN_NOT_FOUND','That pinned report is no longer available in this workspace.');
  return Buffer.from(format==='csv'?run.csv:run.json,'utf8');
}
function query(params:URLSearchParams,exporting:boolean):'json'|'csv'{
  for(const key of new Set(params.keys()))if(!exporting||key!=='format'||params.getAll(key).length!==1)
    invalid('Pinned reports use their saved filters. Only an export format is accepted on downloads.');
  const format=params.get('format')??'json';
  if(format!=='json'&&format!=='csv')invalid('Export format must be JSON or CSV.');
  return format;
}
export = {limits,routePattern,list,create,read,query};
