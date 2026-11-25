'use strict';
const documentAccessPane=$('#document-access-view'),documentAccessPath='/api/document-access';
let documentAccessSequence=0;
const accessModes={text:'Text only','text-and-attachments':'Text and attachments'};
const accessReasons={'operational-need':'Operational need',correction:'Correction','assignment-ended':'Assignment ended','scope-review':'Access review'};
const accessDecisions={approve:'Approve access',reject:'Reject request',revoke:'Revoke access'};
function accessSelect(label,name,items){
  const select=el('select');select.name=name;select.required=true;
  const prompt=el('option','Choose one');prompt.value='';select.append(prompt);
  for(const [value,caption] of items){
    const option=el('option',caption);option.value=value;select.append(option);
  }
  return add(el('label',label),select);
}
async function refreshDocumentAccess(){
  const seq=++documentAccessSequence,session=localSession;
  documentAccessPane.replaceChildren(el('p','Loading document access…'));
  try{
    const model=await read(documentAccessPath);
    if(!documentAccessPane.hidden&&seq===documentAccessSequence&&session===localSession)renderDocumentAccess(model);
  }catch(error){
    if(!documentAccessPane.hidden&&seq===documentAccessSequence&&session===localSession){
      documentAccessPane.replaceChildren(el('p','Could not load document access.'));
      notice(error.message,true);
    }
  }
}
async function sendDocumentAccess(model,form,data){
  if(busy)return;
  busy=true;
  const btn=form.querySelector('button[type=submit]'),seq=documentAccessSequence,session=localSession;
  btn.disabled=true;
  try{
    const updated=await read(documentAccessPath,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...data,expectedRevision:model.revision,reason:new FormData(form).get('reason')})});
    if(!documentAccessPane.hidden&&seq===documentAccessSequence&&session===localSession){
      renderDocumentAccess(updated);
      const id=data.grant??updated.grants[0]?.id;
      const title=id?document.getElementById('document-grant-'+id):null;
      if(title){title.tabIndex=-1;title.focus();}
      notice(data.operation==='propose'?'Document access request recorded.':accessDecisions[data.operation]+' decision recorded.');
    }
  }catch(error){
    if(!documentAccessPane.hidden&&seq===documentAccessSequence&&session===localSession){
      if(error.status===409)await refreshDocumentAccess();
      notice(error.message,true);
    }
  }finally{busy=false;btn.disabled=false;}
}
function docAccessForm(model,label,fields,transform,confirm){
  const form=el('form');form.setAttribute('aria-label',label);
  form.append(...fields,accessSelect('Decision reason','reason',Object.entries(accessReasons)));
  if(confirm){
    const input=el('input');input.required=true;input.type='checkbox';
    form.append(add(el('label'),input,document.createTextNode(' Confirm this decision for the exact published edition.')));
  }
  form.append(button(label,'submit'));
  form.onsubmit=event=>{
    event.preventDefault();
    if(form.reportValidity())sendDocumentAccess(model,form,transform(new FormData(form)));
  };
  return form;
}
function renderDocumentAccess(model){
  const review=model.role==='reviewer';
  const intro=add(el('section'),heading('Scoped access to published editions'),
    el('p',review?'Propose access to a single published edition for a designated case operator. The identity administrator must approve.':
      'Approve, reject or revoke a request without accessing document titles, text or attachments. Verify the exact record and edition IDs before approving.'),
    el('p','Approvals expire after 30 days and never extend to a later edition.','hint'));
  if(review&&model.eligibleAccounts.length&&model.editions.length){
    const {eligibleAccounts,editions}=model;
    intro.append(docAccessForm(model,'Request document access',[
      accessSelect('Case operator','account',eligibleAccounts.map(id=>[id,id])),
      accessSelect('Published edition','edition',editions.map(r=>[r.id,r.title+' · edition '+r.number+' · '+r.id.slice(0,8)])),
      accessSelect('Access level','level',Object.entries(accessModes))
    ],data=>{
      const edition=editions.find(x=>x.id===data.get('edition'));
      return {operation:'propose',document:edition.document,edition:edition.id,account:data.get('account'),level:data.get('level')};
    },false));
  }else if(review)intro.append(el('p','No eligible published editions or current case operator are available.'));
  const list=add(el('section'),heading('Workspace document access requests'));
  if(!model.grants.length)list.append(el('p','No requests have been recorded.'));
  for(const grant of model.grants){
    const title=el('h3',grant.title??('Grant for '+grant.account));title.id='document-grant-'+grant.id;
    const detail=add(el('article',undefined,'module-record'),
      add(el('div',undefined,'row'),title,badge(grant.status)),
      el('p','Account '+grant.account+' · '+accessModes[grant.level]+(grant.number?' · edition '+grant.number:'')),
      add(el('dl'),el('dt','Document ID'),el('dd',grant.document),el('dt','Edition ID'),el('dd',grant.edition)),
      el('p','Requested by '+grant.proposedBy+(grant.decidedBy?' · Decision by '+grant.decidedBy:'')+
        (grant.expiresAt?' · Expiry '+new Date(grant.expiresAt).toISOString().slice(0,10):''),'hint'));
    if(!review){
      const actions=grant.status==='pending'?['approve','reject','revoke']:
        ['approved','stale','expired'].includes(grant.status)?['revoke']:[];
      for(const operation of actions)detail.append(add(el('details'),el('summary',accessDecisions[operation]),
        docAccessForm(model,accessDecisions[operation],[],()=>({operation,grant:grant.id}),true)));
    }
    list.append(detail);
  }
  const audit=add(el('section'),heading('Latest access decisions'));
  if(!model.audit.length)audit.append(el('p','No access decisions recorded.'));
  else{
    const log=el('ul',undefined,'log');audit.append(log);
    for(const row of model.audit)log.append(add(el('li'),el('strong',
      ({propose:'Requested',approve:'Approved',reject:'Rejected',revoke:'Revoked',replaced:'Replaced'})[row.action]+' · '+row.account),
      el('p',row.actor+' · '+accessReasons[row.reason]+' · '+row.at,'hint')));
  }
  documentAccessPane.replaceChildren(intro,list,audit);
}
$('#show-document-access').onclick=()=>switchView('document-access');
