'use strict';
const governancePath='/api/group-governance';
let scopeRequest=0;
const currentScope=()=>localSession?.workspace;
const scopeActions={
  'create-group':'Create group','archive-group':'Archive group','propose-member':'Propose membership',
  'propose-app':'Propose app grant',approve:'Approve',reject:'Reject',revoke:'Revoke'
};
function scopeDate(timestamp){
  return new Date(timestamp).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
async function refreshScopeView(view){
  const panel=$('#'+view+'-view'),request=++scopeRequest,workspace=currentScope();
  panel.replaceChildren(el('p',view==='group-governance'?'Loading group governance…':'Loading scoped applications…'));
  try{
    const model=await read(view==='group-governance'?governancePath:'/api/scoped-applications');
    if(panel.hidden||request!==scopeRequest||workspace!==currentScope())return;
    if(view==='group-governance')renderScopeGovernance(model);else renderScopedApplications(model);
  }catch(error){
    if(!panel.hidden&&request===scopeRequest&&workspace===currentScope()){
      panel.replaceChildren(el('p','This view could not be loaded.'));notice(error.message,true);
    }
  }
}
async function submitScopeOperation(form,model,operation,data,focusId){
  if(busy)return;
  const workspace=currentScope(),panel=$('#group-governance-view');
  busy=true;
  const trigger=form.querySelector('button[type=submit]');
  trigger.disabled=true;
  try{
    const updated=await read(governancePath,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({operation,...data,expectedRevision:model.revision})});
    if(panel.hidden||workspace!==currentScope())return;
    renderScopeGovernance(updated);
    const heading=document.getElementById(focusId);
    if(heading){heading.tabIndex=-1;heading.focus();}
    notice(scopeActions[operation]+' recorded.');
  }catch(error){
    if(!panel.hidden&&workspace===currentScope()){
      if(error.status===409)await refreshScopeView('group-governance');
      notice(error.message,true);
    }
  }finally{busy=false;trigger.disabled=false;}
}
function scopeForm(model,operation,label,children,readValues,focusId,{confirm=false}={}){
  const form=el('form');form.setAttribute('aria-label',label);
  form.append(...children);
  if(confirm){
    const box=el('input');box.type='checkbox';box.required=true;
    form.append(add(el('label'),box,document.createTextNode(' Confirm '+label.toLowerCase()+'.')));
  }
  form.append(button(scopeActions[operation],'submit'));
  form.onsubmit=e=>{
    e.preventDefault();
    if(form.reportValidity()){
      const data=readValues(new FormData(form));
      submitScopeOperation(form,model,operation,data,focusId??'scope-group-'+data.group);
    }
  };
  return form;
}
function scopeSelect(label,items){
  const select=el('select');select.name='target';select.required=true;
  const blank=el('option','Choose one');blank.value='';select.append(blank);
  for(const {id,caption} of items){const option=el('option',caption);option.value=id;select.append(option);}
  return add(el('label',label),select);
}
function scopeActionsForRelationship(model,group,relation){
  const {kind,target}=relation;
  const label=kind==='member'?'membership for '+target:'app grant for '+target;
  const actions=model.role==='identity-admin'&&['pending','approved'].includes(relation.status)?['revoke']:
    model.role==='reviewer'&&relation.status==='pending'?['approve','reject']:[];
  return actions.map(action=>add(el('details'),el('summary',scopeActions[action]+' '+label),
    scopeForm(model,action,scopeActions[action]+' '+label,[],()=>({group:group.id,kind,target}),
      'scope-relation:'+group.id+':'+kind+':'+target,{confirm:true})));
}
function renderScopeGovernance(model){
  const admin=model.role==='identity-admin';
  const panel=$('#group-governance-view'),intro=add(el('section'),heading('Govern access to synthetic app summaries'),
    el('p',admin?'Create a group, then propose individual members and exact apps. A separate reviewer must approve each relationship.':
      'Review each membership or app grant independently. Approval does not create a workspace role or grant access to program records.'),
    el('p','Effective access requires both approvals in the same active group. Approvals expire after 30 days.','hint'));
  if(admin){
    const groupInput=labelled('New synthetic group ID','group','','input');
    const input=groupInput.querySelector('input');input.maxLength=48;input.pattern='[a-z][a-z0-9\\-]{0,47}';
    intro.append(scopeForm(model,'create-group','Create a synthetic group',[groupInput,
      el('p','Use a lowercase ID such as sample-privacy-ops.','hint')],data=>({group:data.get('group')})));
  }
  const listing=add(el('section'),heading('Workspace groups'));
  if(!model.groups.length)listing.append(el('p','No synthetic groups have been set up.'));
  for(const group of model.groups){
    const title=el('h3',group.id);title.id='scope-group-'+group.id;
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),title,badge(group.archived?'Archived':'Active')));
    if(group.archived)card.append(el('p','This archived group grants no access.','hint'));
    if(admin&&!group.archived){
      const subjects=[
        {kind:'member',label:'Eligible workspace account',items:model.eligibleMembers.map(x=>({id:x.id,caption:x.id+' · '+x.role}))},
        {kind:'app',label:'Provisioned application',items:model.catalog.map(x=>({id:x.id,caption:x.name}))}
      ];
      for(const {kind,label,items} of subjects){
        const available=items.filter(x=>!model.relationships.some(r=>r.group===group.id&&r.kind===kind&&r.target===x.id&&
          ['approved','pending'].includes(r.status)));
        const action='propose-'+kind;
        if(available.length)card.append(add(el('details'),el('summary',scopeActions[action]),
          scopeForm(model,action,scopeActions[action]+' for '+group.id,[scopeSelect(label,available)],
            data=>({group:group.id,target:data.get('target')}))));
      }
      card.append(add(el('details'),el('summary','Archive group'),
        scopeForm(model,'archive-group','Archive '+group.id,
          [el('p','This permanently removes access granted by the group.')],()=>({group:group.id}),null,{confirm:true})));
    }
    const rows=model.relationships.filter(r=>r.group===group.id);
    if(!rows.length)card.append(el('p','No memberships or application grants yet.'));
    for(const relation of rows){
      const detail=el('h4',(relation.kind==='member'?'Member: ':'Application: ')+relation.target);
      detail.id='scope-relation:'+group.id+':'+relation.kind+':'+relation.target;
      card.append(add(el('div',undefined,'module-record'),add(el('div',undefined,'row'),detail,badge(relation.status)),
        el('p','Proposed by '+relation.proposedBy+(relation.approvedBy?' · Approved by '+relation.approvedBy:'')+
          (relation.expiresAt?' · Ends '+scopeDate(relation.expiresAt):''),'hint'),
        ...(relation.application?[el('p',relation.application.name+': '+relation.application.summary)]:[]),
        ...(!group.archived?scopeActionsForRelationship(model,group,relation):[])));
    }
    listing.append(card);
  }
  const audit=add(el('section'),heading('Recent group changes'));
  if(!model.audit.length)audit.append(el('p','No local group changes recorded.'));
  else{
    const log=el('ul',undefined,'log');
    for(const row of model.audit)log.append(add(el('li'),el('strong',scopeActions[row.action]+' · '+row.group),
      el('p',row.actor+(row.target?' · '+row.kind+': '+row.target:'')+' · '+row.at,'hint')));
    audit.append(log);
  }
  panel.replaceChildren(intro,listing,audit);
}
function renderScopedApplications(model){
  const content=add(el('section'),heading('Applications available to your account'),
    el('p','Only application summaries approved for your groups appear here. This view does not grant access to any connected application.','hint'));
  if(!model.applications.length)content.append(el('p','No app summaries are currently available to your account.'));
  for(const app of model.applications)content.append(add(el('article',undefined,'module-record'),el('h3',app.name),el('p',app.summary)));
  const refresh=button('Check current app access','button','secondary');
  refresh.onclick=()=>refreshScopeView('scoped-applications');
  content.append(refresh);
  $('#scoped-applications-view').replaceChildren(content);
}
$('#show-group-governance').onclick=()=>switchView('group-governance');
$('#show-scoped-applications').onclick=()=>switchView('scoped-applications');
