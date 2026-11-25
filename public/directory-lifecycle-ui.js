'use strict';
const directoryPane=$('#directory-lifecycle-view'),directoryPath='/api/directory-lifecycle';
let directorySequence=0;
const directoryActions={draft:'Prepare suspension plan',submit:'Submit plan for review',approve:'Approve and suspend accounts',
  reject:'Reject plan',cancel:'Cancel plan'};
const directoryReasons={'end-of-assignment':'End of assignment','directory-reconciliation':'Test directory reconciliation','access-review':'Access review'};
async function refreshDirectoryReconciliation(){
  const n=++directorySequence,session=localSession;
  directoryPane.replaceChildren(el('p','Loading directory reconciliation…'));
  try{
    const model=await read(directoryPath);
    if(!directoryPane.hidden&&session===localSession&&n===directorySequence)renderDirectoryReconciliation(model);
  }catch(error){
    if(!directoryPane.hidden&&session===localSession&&n===directorySequence){
      directoryPane.replaceChildren(el('p','Could not load directory reconciliation.'));
      notice(error.message,true);
    }
  }
}
function directoryActionForm(model,operation,fields,readValues,confirm){
  const form=el('form'),label=directoryActions[operation];
  form.setAttribute('aria-label',label);form.append(...fields);
  if(confirm){
    const input=el('input');input.type='checkbox';input.required=true;
    form.append(add(el('label'),input,document.createTextNode(' Confirm this exact plan digest and decision.')));
  }
  const submit=button(label,'submit');form.append(submit);
  form.onsubmit=async event=>{
    event.preventDefault();
    if(busy||!form.reportValidity())return;
    const seq=directorySequence,session=localSession;
    busy=true;submit.disabled=true;
    try{
      const updated=await read(directoryPath,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({operation,expectedRevision:model.revision,...readValues(new FormData(form))})});
      if(directoryPane.hidden||seq!==directorySequence||session!==localSession)return;
      renderDirectoryReconciliation(updated);
      const id=updated.plans[0]?.id;
      const name=id?document.getElementById('directory-plan-'+id):null;
      if(name){name.tabIndex=-1;name.focus();}
      notice(operation==='approve'?'All listed workspace memberships are suspended.':'Directory decision recorded.');
    }catch(error){
      if(!directoryPane.hidden&&seq===directorySequence&&session===localSession){
        if(error.status===409)await refreshDirectoryReconciliation();
        notice(error.message,true);
      }
    }finally{busy=false;submit.disabled=false;}
  };
  return form;
}
function renderDirectoryReconciliation(model){
  const intro=add(el('section'),heading('Synthetic directory reconciliation'),
    el('p','Review a batch of suspensions for existing fictional accounts in this workspace. This does not import a directory or remove accounts from another workspace.'),
    el('p','Approval immediately revokes existing local sessions for the selected workspace memberships. It does not send messages.','hint'));
  if(model.role==='identity-admin'&&model.candidates.length){
    const accountOptions=add(el('fieldset'),el('legend','Eligible accounts in this workspace'));
    for(const seat of model.candidates){
      const input=el('input');input.type='checkbox';input.name='account';input.value=seat.account;
      accountOptions.append(add(el('label'),input,document.createTextNode(' '+seat.account+' · '+seat.role)));
    }
    const reason=el('select');reason.name='reason';reason.required=true;
    const empty=el('option','Choose one');empty.value='';reason.append(empty);
    for(const value of model.reasons){const option=el('option',directoryReasons[value]);option.value=value;reason.append(option);}
    intro.append(directoryActionForm(model,'draft',[accountOptions,add(el('label','Reconciliation reason'),reason)],
      data=>({accounts:data.getAll('account'),reason:data.get('reason')}),false));
  }else if(model.role==='identity-admin')intro.append(el('p','No active synthetic accounts are eligible for suspension.'));
  const section=add(el('section'),heading('Versioned suspension plans'));
  if(!model.plans.length)section.append(el('p','No suspension plans have been prepared.'));
  for(const plan of model.plans){
    const title=el('h3','Suspension plan '+plan.number);title.id='directory-plan-'+plan.id;
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),title,badge(plan.status)),
      el('p',directoryReasons[plan.reason]+' · Prepared by '+plan.preparedBy+
        (plan.decidedBy?' · Decision by '+plan.decidedBy:'')),
      el('p','Digest: '+plan.digest,'hint'));
    const entries=el('ul');
    for(const m of plan.members)entries.append(el('li',m.account+' · '+m.role+' · Active generation '+m.before.revision+
      ' → Suspended generation '+m.after.revision));
    card.append(entries);
    if(['draft','review'].includes(plan.status)&&!plan.current)
      card.append(el('p','This plan is stale or expired. It cannot suspend any account.','hint'));
    for(const operation of plan.allowed)card.append(add(el('details'),el('summary',directoryActions[operation]),
      directoryActionForm(model,operation,[],()=>({plan:plan.id,digest:plan.digest}),true)));
    section.append(card);
  }
  const audit=add(el('section'),heading('Recent reconciliation activity'));
  if(!model.audit.length)audit.append(el('p','No reconciliation decisions have been recorded.'));
  else{
    const entries=el('ul',undefined,'log');
    for(const e of model.audit)entries.append(add(el('li'),el('strong',e.action.replaceAll('-',' ')),
      el('p',e.actor+' · '+e.at,'hint')));
    audit.append(entries);
  }
  directoryPane.replaceChildren(intro,section,audit);
}
$('#show-directory-lifecycle').onclick=()=>switchView('directory-lifecycle');
