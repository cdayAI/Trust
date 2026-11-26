'use strict';

import {createHash,timingSafeEqual} from 'node:crypto';
interface ReleaseCase {id:string;revision:number;source?:string;kind:string;status:string;closedAt?:unknown;identity?:{status:string};completion?:{method:string;releasedData:boolean}}
interface Receipt {caseId:string;grantId:string;resultBinding?:string}
interface ReleaseVersion {number:number;caseRevision:number;binding:string;template:number;selection:string;digest:string;status:string;authoredBy:string;authoredAt:string;reviewedBy?:string;reviewedAt?:string;releasedAt?:string}
interface ReleaseState {rightsCases?:ReleaseCase[];requesterReceipts?:Receipt[];requesterReleases?:Record<string,ReleaseVersion[]>}
interface ReleaseContext {activeReleaseBinding?:(id:string)=>string|undefined;role:string;account:string}
type Event=(state:ReleaseState,role:string,action:string,projectId:null,id:string,details:Record<string,unknown>)=>unknown;
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
const selections=Object.freeze([
  {id:'category-overview',label:'Fictional categories and counts'},
  {id:'summary-only',label:'Fictional total only'},
]);
const fixtures=Object.freeze([
  {label:'Fictional preference examples',count:2,internalLabel:'fixture-review-note'},
  {label:'Fictional service examples',count:1,internalLabel:'fixture-source-marker'},
]);
const unavailable=()=>({mode:'synthetic-requester-result',status:'not-available'});
const exact=(body:unknown,keys:string[]):body is Record<string,unknown>=>object(body)&&
  Object.keys(body).length===keys.length&&keys.every(k=>Object.hasOwn(body,k));
function fail(status:number,code:string,message:string):never{throw Object.assign(new Error(message),{status,code});}
function notFound():never{return fail(404,'RESULT_CASE_NOT_FOUND','Eligible fictional result case not found.');}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sameDigest(a:unknown,b:unknown):boolean{
  const valid=(value:unknown):value is string=>typeof value==='string'&&value.length===64&&/^[a-f0-9]+$/.test(value);
  return valid(a)&&valid(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function projection(selection:unknown,template:unknown){
  if(template!==1||!selections.some(row=>row.id===selection))return null;
  const total=fixtures.reduce((sum,row)=>sum+row.count,0);
  const sections=selection==='category-overview'?fixtures.map(({label,count})=>({label,count})):[{label:'Fictional example records',count:total}];
  return {title:'Fictional access result',sections};
}
function eligible(row:ReleaseCase|undefined|null):row is ReleaseCase{
  return row?.source==='synthetic-portal'&&row.kind==='access'&&row.status==='fulfilled'&&!!row.closedAt&&row.identity?.status==='verified'&&
    row.completion?.method==='simulation-only'&&row.completion.releasedData===false;
}
function requesterBinding(state:ReleaseState,caseId:string,current:(id:string)=>string|undefined):(Receipt&{resultBinding:string})|null{
  const entries=(state.requesterReceipts??[]).filter(row=>row.caseId===caseId);
  if(entries.length!==1)return null;
  const entry=entries[0];
  return typeof entry.resultBinding==='string'&&sameDigest(entry.resultBinding,current(entry.grantId))?{...entry,resultBinding:entry.resultBinding}:null;
}
function sealed(record:ReleaseVersion|undefined,caseRow:ReleaseCase,entry:Receipt|null){
  if(!record||!entry||record.caseRevision!==caseRow.revision||
    !sameDigest(record.binding,entry.resultBinding))return null;
  const payload=projection(record.selection,record.template);
  if(!payload||!sameDigest(record.digest,digest([caseRow.id,caseRow.revision,record.binding,record.number,record.template,payload])))return null;
  return payload;
}
function presentation(state:ReleaseState,row:ReleaseCase,ctx:ReleaseContext|undefined|null){
  if(!ctx?.activeReleaseBinding||!['analyst','reviewer'].includes(ctx.role)||!eligible(row))return undefined;
  const entry=requesterBinding(state,row.id,ctx.activeReleaseBinding);
  if(!entry)return undefined;
  const versions=state.requesterReleases?.[row.id]??[],candidate=versions.at(-1);
  if(ctx.role==='reviewer'&&!['review','approved','released'].includes(candidate?.status??''))return undefined;
  const preview=sealed(candidate,row,entry);
  if(candidate&&!preview)return undefined;
  const actions:string[]=[];
  const authored=candidate?.authoredBy===ctx.account;
  if(ctx.role==='analyst'&&versions.length<16&&(!candidate||(authored&&['draft','returned'].includes(candidate.status))))actions.push('draft');
  if(ctx.role==='analyst'&&authored&&candidate?.status==='draft')actions.push('submit');
  if(ctx.role==='reviewer'&&candidate&&!authored&&candidate.status==='review')actions.push('approve','return');
  if(ctx.role==='reviewer'&&candidate?.status==='approved'&&candidate.reviewedBy===ctx.account&&!authored)actions.push('release');
  return {version:candidate?.number??0,stage:candidate?.status??'not-prepared',actions,selections,
    ...(candidate?{digest:candidate.digest,selection:candidate.selection,preview}:{})};
}
function change(state:ReleaseState,caseId:string,action:string,ctx:ReleaseContext|undefined|null,body:unknown,event:Event){
  const row=(state.rightsCases??[]).find(x=>x.id===caseId);
  if(!ctx?.activeReleaseBinding||!eligible(row))return notFound();
  const entry=requesterBinding(state,caseId,ctx.activeReleaseBinding);
  if(!entry)return notFound();
  const required=action==='draft'?['expectedRevision','selection']:['expectedRevision','digest'];
  if(action==='release')required.push('confirm');
  if(!exact(body,required)||typeof body.expectedRevision!=='number'||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||
    (action==='release'&&body.confirm!==true))fail(422,'RESULT_FIELDS','Use the exact fictional result form and explicit confirmation.');
  const versions=state.requesterReleases?.[caseId]??[];
  const previous=versions.at(-1);
  if(body.expectedRevision!==(previous?.number??0)||(action!=='draft'&&!sameDigest(previous?.digest,body.digest)))
    fail(409,'STALE_RESULT','This result changed. Reload before retrying.');
  const model=presentation(state,row,ctx);
  if(!model?.actions.includes(action))fail(409,'RESULT_ACTION_UNAVAILABLE','The current result stage does not allow this action.');
  const now=new Date().toISOString();
  let current=previous;
  if(action==='draft'){
    const payload=projection(body.selection,1),number=versions.length+1;
    if(!payload||typeof body.selection!=='string')fail(422,'RESULT_SELECTION','Select a bundled fictional result projection.');
    if(previous?.status==='draft')previous.status='superseded';
    current={number,caseRevision:row.revision,binding:entry.resultBinding,template:1,selection:body.selection,
      digest:digest([row.id,row.revision,entry.resultBinding,number,1,payload]),status:'draft',authoredBy:ctx.account,authoredAt:now};
    (state.requesterReleases??={})[caseId]=[...versions,current];
  }else{
    if(!current||!['submit','approve','return','release'].includes(action))throw Error('Missing eligible release transition.');
    const status:Record<string,string>={submit:'review',approve:'approved',return:'returned',release:'released'};
    current.status=status[action];
    if(action==='approve'){current.reviewedBy=ctx.account;current.reviewedAt=now;}
    if(action==='release')current.releasedAt=now;
  }
  event(state,ctx.role,'requester-release.'+action,null,caseId,{revision:current.number,stage:current.status,caseRevision:row.revision});
}
function publicResult(state:ReleaseState,grant:{id:string;releaseBinding?:string}){
  if(!grant.releaseBinding)return unavailable();
  const entries=(state.requesterReceipts??[]).filter(entry=>entry.grantId===grant.id);
  if(entries.length!==1||!sameDigest(entries[0].resultBinding,grant.releaseBinding))return unavailable();
  const entry=entries[0],row=(state.rightsCases??[]).find(x=>x.id===entry.caseId);
  if(!eligible(row))return unavailable();
  const record=state.requesterReleases?.[row.id]?.at(-1),payload=sealed(record,row,entry);
  if(!payload||!record||record.status!=='released'||!record.reviewedBy||record.reviewedBy===record.authoredBy||!record.releasedAt)return unavailable();
  return {mode:'synthetic-requester-result',status:'available',result:payload};
}
export = {presentation,change,publicResult};
