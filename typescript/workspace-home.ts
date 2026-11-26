'use strict';
import type {QueueTask,QueueModel,SummaryCounts} from './contracts';
const {view:queueView}:{view(state:unknown,params:URLSearchParams,asOf:string):QueueModel}=require('./work-queue');
const {model:myWork}:{model(state:unknown,selection:unknown,views:readonly string[],params:URLSearchParams,key:undefined,asOf:string):{tasks:{timing:string}[]}}=require('./my-work');
interface HomeContext {mode:string;actor:string;selection?:unknown;views:readonly string[]}
interface Triage extends SummaryCounts {workflows:{id:string;label:string;total:number;overdue:number;dueToday:number}[]}

const empty=():SummaryCounts=>({total:0,overdue:0,dueToday:0,upcoming:0,undated:0});
function count(rows:readonly {timing:string}[]):SummaryCounts{
  const summary=empty();
  for(const row of rows){
    summary.total++;
    if(row.timing==='overdue')summary.overdue++;
    else if(row.timing==='due-today')summary.dueToday++;
    else if(row.timing==='upcoming')summary.upcoming++;
    else summary.undated++;
  }
  return summary;
}

function dashboard(state:unknown,{mode,actor,selection,views}:HomeContext,params:URLSearchParams,asOf=new Date().toISOString().slice(0,10)){
  if(params.size)throw Object.assign(new Error('Workspace home does not accept filters.'),{status:422});
  const enabled=new Set(views);
  const demo=mode==='synthetic-demo';
  // The restricted case seat must never compute or return workspace-level aggregates.
  const personal=selection?myWork(state,selection,views,new URLSearchParams(),undefined,asOf).tasks:null;
  const queue=enabled.has('queue')?queueView(state,new URLSearchParams(),asOf):null;
  const workspace=queue?.tasks.filter(row=>enabled.has(row.destination.view))??[];
  const demoAssigned=()=>queue?workspace.filter(row=>row.owner===actor):
    queueView(state,new URLSearchParams({owner:actor}),asOf).tasks.filter(row=>enabled.has(row.destination.view));
  const assigned=personal??demoAssigned();
  let triage:Triage|null=null;
  if(queue){
    const groups=new Map<string,SummaryCounts>();
    for(const task of workspace){
      if(!groups.has(task.workflow))groups.set(task.workflow,empty());
      const group=groups.get(task.workflow)!;
      group.total++;
      if(task.timing==='overdue')group.overdue++;
      if(task.timing==='due-today')group.dueToday++;
    }
    triage={...count(workspace),workflows:[...groups.entries()].sort((a,b)=>b[1].overdue-a[1].overdue||
      b[1].dueToday-a[1].dueToday||b[1].total-a[1].total||a[0].localeCompare(b[0]))
      .map(([id,{total,overdue,dueToday}])=>({id,label:queue.workflowLabels[id],total,overdue,dueToday}))};
  }
  // Deliberately expose only aggregate display values, no task/record objects or keys.
  return {mode,asOf,assigned:count(assigned),...(triage?{triage}:{}),scope:demo?'demo-role':'assigned-seat'};
}
export = {dashboard};
