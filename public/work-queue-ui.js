'use strict';
const queuePane=$('#queue-view'),queuePath='/api/work-queue',queuePageSize=25;
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
function openQueueFromHome({owner='all',workflow='all',timing='all'}={}){
  queueFilters={owner,workflow,timing};
  switchView('queue');
}
function queueParams(){
  return new URLSearchParams({owner:queueFilters.owner??actor,workflow:queueFilters.workflow,timing:queueFilters.timing});
}
async function refreshQueue(cursor=null,{focusPage=false,message=''}={}){
  const seq=++queueSequence;
  const params=queueParams();
  params.set('limit',String(queuePageSize));
  if(cursor)params.set('cursor',cursor);
  queuePane.setAttribute('aria-busy','true');
  const current=()=>!queuePane.hidden&&seq===queueSequence;
  try{
    const model=await read(queuePath+'?'+params,{headers:{'X-Demo-Actor':actor}});
    if(current()){
      renderQueue(model,{focusPage});
      if(message)notice(message);
    }
  }catch(error){
    if(!current())return;
    if(cursor&&error.status===409){
      // The data, role scope, or UTC day changed. Never append to an old
      // projection or keep moving through it.
      return await refreshQueue(null,{focusPage:true,message:'Work queue changed. Showing the first page.'});
    }
    const retry=button('Retry work queue','button','secondary');
    retry.onclick=()=>refreshQueue(null,{focusPage:true});
    queuePane.replaceChildren(add(el('section'),el('p','The work queue could not be loaded.'),retry));
    notice(error.message,true);
    if(focusPage)retry.focus({preventScroll:true});
  }finally{if(seq===queueSequence)queuePane.setAttribute('aria-busy','false');}
}
function renderQueue(model,{focusPage=false}={}){
  const {actors,workflowLabels,filters,counts,asOf,tasks,pagination}=model;
  const seq=queueSequence;
  const ownerName=id=>actors.find(x=>x.id===id)?.name??id;
  const head=add(el('section'),heading('Work queue'),el('p','Open work reflects the current workflow records. No duplicate task records or notifications are created.'),
    el('p','As of '+asOf+' UTC · '+counts.total+' open · '+counts.overdue+' overdue · '+counts.dueToday+' due today','hint'));
  const filterForm=add(el('form'),
    rightsSelect('Queue owner','owner',[{value:'all',label:'Everyone'},...actors.map(a=>({value:a.id,label:a.name}))],filters.owner),
    rightsSelect('Workflow filter','workflow',[{value:'all',label:'All workflows'},...Object.entries(workflowLabels).map(([value,label])=>({value,label}))],filters.workflow),
    rightsSelect('Due-date filter','timing',[{value:'all',label:'Any due date'},...Object.entries(timingLabel).map(([value,label])=>({value,label}))],filters.timing),
    button('Apply filters','submit'));
  filterForm.onsubmit=e=>{e.preventDefault();queueFilters=Object.fromEntries(new FormData(filterForm));notice('');refreshQueue(null,{focusPage:true})};
  const download=el('a','Export filtered queue JSON','button quiet');download.href=scopeUrl(queuePath+'/export?'+new URLSearchParams(filters));download.download='';
  head.append(filterForm,download);
  const list=add(el('section'),heading('Actionable work'));
  let pageStatus;
  if(pagination){
    pageStatus=el('p',pagination.total?'Showing '+pagination.first+'–'+pagination.last+' of '+pagination.total+' tasks':'Showing 0 tasks','hint');
    pageStatus.tabIndex=-1;
    const previous=button('Previous queue page','button','secondary'),next=button('Next queue page','button','secondary');
    const navigation=add(el('nav',undefined,'actions'),previous,next);
    navigation.setAttribute('aria-label','Work queue pages');
    previous.disabled=!pagination.previousCursor;next.disabled=!pagination.nextCursor;
    function move(cursor){
      previous.disabled=true;next.disabled=true;notice('');
      refreshQueue(cursor,{focusPage:true});
    }
    previous.onclick=()=>move(pagination.previousCursor);next.onclick=()=>move(pagination.nextCursor);
    list.append(pageStatus,navigation);
  }
  if(!tasks.length)list.append(el('p','No open work matches these filters.'));
  for(const item of tasks){
    const box=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',item.label),badge(timingLabel[item.timing])),
      el('p',item.title+' · '+workflowLabels[item.workflow]),el('p',ownerName(item.owner)+(item.dueDate?' · Due '+item.dueDate+' UTC':''),'hint'));
    const link=button('Open record','button','secondary');
    link.setAttribute('aria-label','Open record: '+item.title+' · '+item.label);
    link.onclick=()=>openWorkTask(item.destination,{isCurrent:()=>!queuePane.hidden&&seq===queueSequence});
    box.append(link);list.append(box);
  }
  queuePane.replaceChildren(head,list);
  if(focusPage)pageStatus?.focus({preventScroll:true});
}
$('#show-queue').onclick=()=>switchView('queue');
$('#actor').addEventListener('change',()=>{queueFilters.owner=null;if(!queuePane.hidden)refreshQueue()});
