'use strict';
const identityPane=$('#identity-admin-view'),identityPath='/api/identity-admin';
const membershipLabels:Record<string,string>={
  active:'Active',disabled:'Disabled in this workspace','configuration-disabled':'Disabled in provisioning',expired:'Expired'
};
const operationLabels:Record<string,string>={enable:'Access enabled',disable:'Access disabled',revoke:'Sessions revoked'};
let identityRequest=0;

async function refreshIdentityAdmin(){
  const sequence=++identityRequest;
  try{
    const model=await read<BrowserIdentityModel>(identityPath);
    if(!identityPane.hidden&&sequence===identityRequest)renderIdentityAdmin(model);
  }catch(error){
    if(!identityPane.hidden&&sequence===identityRequest){
      identityPane.replaceChildren(el('p','The current workspace roster could not be loaded.'));
      notice(error instanceof Error?error.message:String(error),true);
    }
  }
}

async function changeIdentity(form:HTMLFormElement,member:BrowserIdentityMember,operation:BrowserIdentityOperation){
  if(busy)return;
  const submit=form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if(!submit)return;
  busy=true;submit.disabled=true;
  try{
    const model=await read<BrowserIdentityModel>(identityPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      target:member.id,operation,reason:new FormData(form).get('reason'),expectedRevision:member.revision
    })});
    if(!identityPane.hidden){
      renderIdentityAdmin(model);
      const updated=document.getElementById('identity-member-'+member.id);
      if(updated){updated.tabIndex=-1;updated.focus();}
      notice(operationLabels[operation]+' for '+member.id+'.');
    }
  }catch(error){
    if(!identityPane.hidden){
      if(error instanceof Error&&'status' in error&&error.status===409)await refreshIdentityAdmin();
      notice(error instanceof Error?error.message:String(error),true);
    }
  }finally{busy=false;submit.disabled=false;}
}

function operationForm(member:BrowserIdentityMember,operation:BrowserIdentityOperation,model:BrowserIdentityModel){
  const {label,reason}=model.operations[operation];
  const form=el('form');
  form.setAttribute('aria-label',label+' for '+member.id);
  const select=el('select');select.name='reason';select.required=true;
  const empty=el('option','Choose a reason');empty.value='';select.append(empty);
  for(const code of reason){const option=el('option',model.reasons[code]);option.value=code;select.append(option);}
  const confirmation=el('input');confirmation.type='checkbox';confirmation.required=true;
  const action=button(label,'submit');
  form.append(add(el('label','Reason'),select),add(el('label'),confirmation,
    document.createTextNode(' Confirm this action for '+member.id+' in this workspace.')),action);
  form.onsubmit=event=>{event.preventDefault();if(form.reportValidity())changeIdentity(form,member,operation);};
  return add(el('details'),el('summary',label),form);
}

function renderIdentityAdmin(model:BrowserIdentityModel){
  const summary=add(el('section'),heading('Workspace account roster'),
    el('p','Manage existing synthetic accounts in this workspace. Credentials and roles are provisioned outside this page.'),
    el('p','Disabling access or revoking sessions does not affect a person’s other workspaces.','hint'));
  const list=add(el('section'),heading('Provisioned accounts'));
  for(const member of model.members){
    const name=el('h3',member.id);name.id='identity-member-'+member.id;
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),name,badge(membershipLabels[member.status]??member.status)),
      el('p',member.role+' · revision '+member.revision,'hint'));
    if(member.role==='identity-admin')card.append(el('p','Protected administrator seat.','hint'));
    for(const operation of member.allowed)card.append(operationForm(member,operation,model));
    list.append(card);
  }
  const audit=add(el('section'),heading('Recent access changes'));
  if(!model.audit.length)audit.append(el('p','No access changes recorded.'));
  else{
    const log=el('ul',undefined,'log');
    for(const row of model.audit)log.append(add(el('li'),el('strong',(operationLabels[row.action]??row.action)+' · '+row.target),
      el('p',row.actor+' · '+(model.reasons[row.reason]??row.reason)+' · '+row.at+' · revision '+row.revision,'hint')));
    audit.append(log);
  }
  identityPane.replaceChildren(summary,list,audit);
}
$('#show-identity-admin').onclick=()=>switchView('identity-admin');
