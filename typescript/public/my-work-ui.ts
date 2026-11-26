'use strict';
const myWorkPane=$('#my-work-view');
const myWorkPath='/api/my-work';
const ownLinkPattern=/^#my-work\/([a-f0-9]{64})$/;
let myWorkSequence=0,ownLinkSequence=0,openedOwnLink=false;
function clearMyWorkLocation(){
  ownLinkSequence++;
  openedOwnLink=false;
  if(ownLinkPattern.test(location.hash))history.replaceState(null,'',location.pathname+location.search);
}
function renderMyWork({asOf,tasks}:BrowserAssignedWork){
  const colors:Record<BrowserTiming,string>={overdue:'Overdue','due-today':'Due today',upcoming:'Upcoming','no-date':'No due date'};
  const intro=add(el('section'),heading('Assigned work'),el('p','Only tasks assigned to your role in this workspace appear here.'),
    el('p',tasks.length+' open · '+tasks.filter(task=>task.timing==='overdue').length+' overdue · As of '+asOf+' UTC','hint'));
  const refresh=button('Refresh my work','button','secondary');refresh.onclick=()=>refreshMyWork();intro.append(refresh);
  const list=add(el('section'),heading('Next actions'));
  if(!tasks.length)list.append(el('p','No open tasks are assigned to you.'));
  for(const row of tasks){
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',row.actionLabel),badge(colors[row.timing])),
      el('p',row.recordLabel+' · '+row.workflowName),el('p',row.dueDate?'Due '+row.dueDate+' UTC':'No assigned deadline','hint'));
    const link=el('a','Open record','button quiet');
    link.href='#my-work/'+row.key;
    link.setAttribute('aria-label','Open assigned record: '+row.recordLabel+' · '+row.actionLabel);
    link.onclick=event=>{if(location.hash===link.hash){event.preventDefault();openMyWorkLocation();}};
    card.append(link);list.append(card);
  }
  myWorkPane.replaceChildren(intro,list);
}
async function refreshMyWork(){
  const seq=++myWorkSequence;
  try{
    const model=await read<BrowserAssignedWork>(myWorkPath);
    if(!myWorkPane.hidden&&seq===myWorkSequence)renderMyWork(model);
  }catch(error){
    if(!myWorkPane.hidden&&seq===myWorkSequence){
      const retry=button('Retry my work','button','secondary');retry.onclick=()=>refreshMyWork();
      myWorkPane.replaceChildren(el('p','Assigned work could not be loaded.'),retry);
      notice(error instanceof Error?error.message:String(error),true);
    }
  }
}
async function openMyWorkLocation(){
  if(!localSession?.authenticated||!localSession.capabilities.views.includes('my-work'))return;
  const key=location.hash.match(ownLinkPattern)?.[1];
  if(!key){
    if(openedOwnLink){openedOwnLink=false;ownLinkSequence++;switchView('my-work',{keepMyWorkLink:true});}
    return;
  }
  const seq=++ownLinkSequence;
  openedOwnLink=true;
  if(myWorkPane.hidden)switchView('my-work',{keepMyWorkLink:true});
  try{
    const {destination}=await read<{destination:BrowserWorkDestination}>(myWorkPath+'/tasks/'+key);
    if(seq!==ownLinkSequence)return;
    if(!localSession.capabilities.views.includes(destination.view))throw new Error('Assigned work item is unavailable.');
    await openWorkTask(destination,{keepMyWorkLink:true,isCurrent:()=>seq===ownLinkSequence});
  }catch(error){
    if(seq===ownLinkSequence)notice(error instanceof Error&&'status' in error&&error.status===404?'This work item is no longer assigned to you.':error instanceof Error?error.message:String(error),true);
  }
}
window.addEventListener('hashchange',openMyWorkLocation);
$('#show-my-work').onclick=()=>switchView('my-work');
