'use strict';
const queuePane=$('#queue-view'),queuePath='/api/work-queue';
let queueFilters={owner:null,workflow:'all',timing:'all'},queueSequence=0,queueTarget=null;
const timingLabel={overdue:'Overdue','due-today':'Due today',upcoming:'Upcoming','no-date':'No due date'};
function focusWorkRecord(view){
  if(queueTarget?.view!==view)return;
  const record=$('#show-'+view)?.getAttribute('aria-current')==='true'
    ?document.getElementById('work-record-'+queueTarget.recordId):null;
  queueTarget=null;
  if(!record){notice('The underlying record is no longer available in this view.',true);return}
  record.tabIndex=-1;record.focus({preventScroll:true});record.scrollIntoView({block:'center'});
}
async function openWorkTask(target,{keepMyWorkLink=false,isCurrent=()=>true}={}){
  try{
    if(target.view==='assessments'){
      const next=await read('/api/state');
      if(!isCurrent())return;
      state=next;
      selected=target.projectId;
    }
    if(!isCurrent())return;
    queueTarget=target;
    switchView(target.view,{keepMyWorkLink});
    if(target.view==='assessments')focusWorkRecord('assessments');
  }catch(e){if(isCurrent()){queueTarget=null;notice(e.message,true)}}
}
function queueParams(){
  return new URLSearchParams({owner:queueFilters.owner??actor,workflow:queueFilters.workflow,timing:queueFilters.timing});
}
async function refreshQueue(){
  const seq=++queueSequence;
  try{
    const model=await read(queuePath+'?'+queueParams().toString());
    if(!queuePane.hidden&&seq===queueSequence)renderQueue(model);
  }catch(error){if(!queuePane.hidden&&seq===queueSequence){queuePane.replaceChildren(el('p','The work queue could not be loaded.'));notice(error.message,true)}}
}
function renderQueue(model){
  const {actors,workflowLabels,filters,counts,asOf,tasks}=model;
  const ownerName=id=>actors.find(x=>x.id===id)?.name??id;
  const head=add(el('section'),heading('Work queue'),el('p','Open work reflects the current workflow records. No duplicate task records or notifications are created.'),
    el('p','As of '+asOf+' UTC · '+counts.total+' open · '+counts.overdue+' overdue · '+counts.dueToday+' due today','hint'));
  const filterForm=add(el('form'),
    rightsSelect('Queue owner','owner',[{value:'all',label:'Everyone'},...actors.map(a=>({value:a.id,label:a.name}))],filters.owner),
    rightsSelect('Workflow filter','workflow',[{value:'all',label:'All workflows'},...Object.entries(workflowLabels).map(([value,label])=>({value,label}))],filters.workflow),
    rightsSelect('Due-date filter','timing',[{value:'all',label:'Any due date'},...Object.entries(timingLabel).map(([value,label])=>({value,label}))],filters.timing),
    button('Apply filters','submit'));
  filterForm.onsubmit=e=>{e.preventDefault();queueFilters=Object.fromEntries(new FormData(filterForm));refreshQueue()};
  const download=el('a','Export filtered queue JSON','button quiet');download.href=scopeUrl(queuePath+'/export?'+new URLSearchParams(filters));download.download='';
  head.append(filterForm,download);
  const list=add(el('section'),heading('Actionable work'));
  if(!tasks.length)list.append(el('p','No open work matches these filters.'));
  for(const item of tasks){
    const box=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',item.label),badge(timingLabel[item.timing])),
      el('p',item.title+' · '+workflowLabels[item.workflow]),el('p',ownerName(item.owner)+(item.dueDate?' · Due '+item.dueDate+' UTC':''),'hint'));
    const link=button('Open record','button','secondary');
    link.setAttribute('aria-label','Open record: '+item.title+' · '+item.label);
    link.onclick=()=>openWorkTask(item.destination);
    box.append(link);list.append(box);
  }
  queuePane.replaceChildren(head,list);
}
$('#show-queue').onclick=()=>switchView('queue');
$('#actor').addEventListener('change',()=>{queueFilters.owner=null;if(!queuePane.hidden)refreshQueue()});
