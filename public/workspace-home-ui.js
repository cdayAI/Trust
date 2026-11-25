'use strict';
const homePane=$('#home-view');
let homeGeneration=0;
const homeAllowed=view=>localSession?.authenticated?localSession.capabilities.views.includes(view):
  (actor==='case-operator'?['rights','governance-docs']:['queue','report','rights','incidents','governance-docs']).includes(view);

function homeFocus(){
  const name=$('#view-title');
  name.tabIndex=-1;
  name.focus({preventScroll:true});
  window.scrollTo({top:0,behavior:'instant'});
}
function homeButton(text,view,options,{quiet=false}={}){
  if(!homeAllowed(view))return null;
  const control=button(text,'button',quiet?'secondary':undefined);
  control.onclick=()=>{
    if(view==='queue')openQueueFromHome(options);
    else switchView(view);
    homeFocus();
  };
  return control;
}
function homeAction(root,text,view,options,appearance){
  const control=homeButton(text,view,options,appearance);
  if(control)root.append(control);
}
function homePanel(kicker,title,liquid=false){
  return add(el('section',undefined,liquid?'home-panel home-liquid':'home-panel'),
    el('p',kicker,'home-eyebrow'),heading(title));
}
function homeCount(label,value,emphasis){
  return add(el('div',undefined,'home-stat'+(emphasis?' home-urgent':'')),
    el('dt',label),el('dd',String(value)));
}
function homeCounts(counts){
  return add(el('dl',undefined,'home-stats'),homeCount('Open',counts.total),
    homeCount('Overdue',counts.overdue,counts.overdue>0),homeCount('Due today',counts.dueToday),
    homeCount('Upcoming',counts.upcoming),homeCount('No date',counts.undated));
}

function renderWorkspaceHome(model,{focusRefresh=false}={}){
  const {mode,asOf,assigned,triage}=model;
  const current=add(el('div',undefined,'home-toolbar'),
    el('p',mode==='synthetic-demo'?'Synthetic demo · current demo role':'Local workspace · current verified role','home-context'),
    el('p','As of '+asOf+' UTC','home-date'));
  const refresh=button('Refresh home summary','button','secondary');
  refresh.onclick=()=>refreshWorkspaceHome({focusRefresh:true});
  current.append(refresh);
  const primary=homePanel('01 / Start here','My next actions',true);
  primary.append(el('p',assigned.total?'Open workflow actions currently assigned to this role.':
    'Nothing is currently assigned. New work will appear here after its workflow moves to your role.'));
  const actions=el('div',undefined,'actions home-actions');
  if(mode==='synthetic-demo'&&actor==='case-operator')homeAction(actions,'Open Privacy Rights','rights');
  else if(mode==='synthetic-demo')homeAction(actions,'Open demo role queue','queue',{owner:actor});
  else homeAction(actions,'Open My Work','my-work');
  primary.append(actions,homeCounts(assigned));
  const body=add(el('div',undefined,'home-primary'+(triage?' home-primary-two':'')),primary);
  if(triage){
    const attention=homePanel('02 / Prioritize','Workspace triage',true);
    attention.append(el('p',triage.total?'Open actions across the seven shared work-queue workflows.':
      'No open actions in the shared work queue.'));
    attention.append(homeCounts(triage));
    const controls=el('div',undefined,'actions home-actions');
    homeAction(controls,'Open shared queue','queue');
    if(triage.overdue)homeAction(controls,'View overdue work','queue',{timing:'overdue'},{quiet:true});
    if(triage.dueToday)homeAction(controls,'View due-today work','queue',{timing:'due-today'},{quiet:true});
    attention.append(controls);body.append(attention);
  }
  const secondary=el('div',undefined,'home-secondary'+(triage?' home-secondary-two':''));
  if(triage){
    const pulse=homePanel('Workflow breakdown','Where work is open');
    if(!triage.workflows.length)pulse.append(el('p','The shared queue has no open work to break down.'));
    const list=el('ul',undefined,'home-workflows');
    for(const group of triage.workflows){
      const row=el('li');
      const labels=add(el('div',undefined,'home-workflow-label'),el('h3',group.label),
        el('p',group.total+' open · '+group.overdue+' overdue · '+group.dueToday+' due today'));
      const work=el('meter');work.min=0;work.max=triage.total;work.value=group.total;
      work.setAttribute('aria-label',group.label+' share of open shared work');
      labels.append(work);row.append(labels);
      homeAction(row,'Triage '+group.label,'queue',{workflow:group.id},{quiet:true});
      list.append(row);
    }
    pulse.append(list);secondary.append(pulse);
  }
  const explore=homePanel('Navigate','Continue in the workspace');
  const nav=el('div',undefined,'home-shortcuts');
  function shortcut(view,label,description){
    if(!homeAllowed(view))return;
    const link=homeButton(label,view,undefined,{quiet:true});
    nav.append(add(el('div',undefined,'home-shortcut'),link,el('p',description)));
  }
  shortcut('report','Open Operational Reporting','Explore current workflow and audit totals with filters and exports.');
  if(mode!=='synthetic-demo'||actor!=='case-operator')shortcut('rights','Open Privacy Rights','Resume identity review or mock fulfillment within your authorized scope.');
  shortcut('incidents','Open Incident Triage','Review open investigations and independent notice decisions.');
  shortcut('governance-docs','Open Policies and Documents','Browse the policy and evidence versions this role can access.');
  explore.append(nav);secondary.append(explore);
  homePane.replaceChildren(current,body,secondary);
  if(focusRefresh)refresh.focus({preventScroll:true});
}

async function refreshWorkspaceHome({focusRefresh=false}={}){
  const request=++homeGeneration,role=actor;
  homePane.setAttribute('aria-busy','true');
  homePane.replaceChildren(add(el('section',undefined,'home-panel'),heading('Preparing the workspace'),
    el('p','Loading counts for the current role…')));
  try{
    const model=await read('/api/workspace-home',{headers:{'X-Demo-Actor':role}});
    if(homePane.hidden||request!==homeGeneration||role!==actor)return;
    renderWorkspaceHome(model,{focusRefresh});
  }catch{
    if(homePane.hidden||request!==homeGeneration||role!==actor)return;
    const fail=homePanel('Home summary','Summary unavailable');
    fail.append(el('p','Counts could not be loaded. You can try again or open a workspace view directly.'));
    const options=el('div',undefined,'actions home-actions');
    const retry=button('Retry home summary','button','secondary');retry.onclick=()=>refreshWorkspaceHome({focusRefresh:true});
    options.append(retry);
    homeAction(options,localSession?.authenticated?'Open My Work':'Open demo role queue',
      localSession?.authenticated?'my-work':'queue',{owner:actor});
    if(actor==='case-operator')homeAction(options,'Open Privacy Rights','rights',undefined,{quiet:true});
    homeAction(options,'Open Operational Reporting','report',undefined,{quiet:true});
    fail.append(options);homePane.replaceChildren(fail);
    if(focusRefresh)retry.focus({preventScroll:true});
  }finally{
    if(request===homeGeneration)homePane.setAttribute('aria-busy','false');
  }
}
$('#show-home').onclick=()=>{switchView('home');homeFocus();};
$('#actor').addEventListener('change',()=>{if(!homePane.hidden)refreshWorkspaceHome()});
