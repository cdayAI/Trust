'use strict';

let rightsData,rightsSequence=0;
const rightsPath='/api/rights/cases';
const rightsPane=$('#rights-view');
const kindLabel=k=>({access:'Access',deletion:'Deletion',correction:'Correction',portability:'Portability','opt-out':'Opt-out'}[k]??k);
const rightActionLabel={assign:'Reassign','verify':'Mark identity verified','deny-verification':'Mark identity not verified',
  begin:'Begin fulfillment',fulfill:'Document mock fulfillment','close-unverified':'Close without disclosure'};
function rightsSelect(text,name,options,selected){
  const select=el('select');
  select.name=name;select.required=true;
  for(const {value,label} of options){
    const option=el('option',label);option.value=value;select.append(option);
  }
  select.value=selected??options[0]?.value??'';
  return add(el('label',text),select);
}
function rightsNote(text){
  const label=labelled(text,'note','');
  label.querySelector('textarea').maxLength=1000;
  return label;
}
async function refreshRights(){
  const sequence=++rightsSequence;
  try{
    const next=await read(rightsPath);
    if(sequence===rightsSequence&&!rightsPane.hidden){rightsData=next;renderRights();}
  }catch(e){
    if(sequence===rightsSequence&&!rightsPane.hidden){rightsPane.replaceChildren(el('p','Privacy rights cases could not be loaded.'));notice(e.message,true)}
  }
}
function rightsForm(target,path,fields,requestBody,caption){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy)return;
    busy=true;++rightsSequence;const submit=form.querySelector('button');submit.disabled=true;
    try {
      const values=Object.fromEntries(new FormData(form));
      rightsData=await read(path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},
        body:JSON.stringify(requestBody(values))});
      if(!rightsPane.hidden){renderRights();notice('Privacy rights case updated.')}
    }catch(err){
      if(!rightsPane.hidden){
        notice(err.message,true);
        if(err.status===409&&err.message.includes('Reload')){
          const reload=button('Reload cases','button','secondary');
          reload.onclick=async()=>{notice('');await refreshRights()};
          $('#notice').append(document.createTextNode(' '),reload);
        }
      }
    }finally{busy=false;submit.disabled=false}
  };
  target.append(form);
}
function renderCaseDelegation(card,row,board){
  const grant=board?.cases.find(item=>item.id===row.id);
  if(!grant)return;
  const panel=add(el('details'),el('summary','Account access'),
    el('p','Delegation: '+grant.status.replaceAll('-',' ')+(grant.account?' · '+grant.account:'')+
      (grant.status==='active'&&grant.expiresAt?' · expires '+new Date(grant.expiresAt).toISOString().slice(0,10):''),
      'hint'),
    el('p','Assigning the case-operator role alone does not share this case. An account delegation expires after 30 days.','hint'));
  const reasons={'case-assignment':'Case assignment','coverage-change':'Coverage change','scope-review':'Access review','assignment-ended':'Assignment ended'};
  const reasonField=()=>rightsSelect('Delegation reason','reason',board.reasons.map(value=>({value,label:reasons[value]})),
    grant.status==='active'?'assignment-ended':'case-assignment');
  const confirmed=message=>{
    const input=el('input');input.type='checkbox';input.required=true;
    return add(el('label'),input,document.createTextNode(' '+message));
  };
  const path=rightsPath+'/'+encodeURIComponent(row.id)+'/delegation';
  if(grant.canDelegate&&grant.status!=='active'&&board.accounts.length)
    rightsForm(panel,path,[rightsSelect('Specific local case operator','account',board.accounts.map(value=>({value,label:value}))),
      reasonField(),confirmed('Confirm delegation of this exact case.')],
      values=>({...values,operation:'delegate',expectedRevision:row.revision}),'Delegate this case');
  if(grant.account&&grant.status!=='revoked')
    rightsForm(panel,path,[reasonField(),confirmed('Confirm revocation of this case delegation.')],
      values=>({...values,operation:'revoke',expectedRevision:row.revision}),'Revoke case access');
  card.append(panel);
}
function requesterIntakePanel(model){
  const section=add(el('section'),heading('Requester intake form'),el('p',
    'Configure fixed fictional choices, counts and yes/no fields. No contact details or free text can be collected.'),
    el('p',model.history.length?'Current published form: version '+model.history.at(-1).number:
      'Legacy requester form is in use until the first independent approval.','hint'));
  const {draft,allowed,revision}=model;
  const formPath='/api/rights/intake-form/';
  if(draft){
    section.append(el('p','Version '+draft.number+' · '+(draft.status==='review'?'Awaiting independent review':'Draft')));
    const selected=el('ul');
    for(const field of draft.fields)selected.append(el('li',model.options.find(f=>f.key===field.key).label+
      (field.required?' · Required':' · Optional')));
    section.append(selected);
    if(draft.returnReason)section.append(el('p','Returned: '+draft.returnReason.replaceAll('-',' '),'hint'));
  }
  if(allowed.includes('save')){
    const groups=model.options.map(field=>{
      const checks=el('fieldset'),use=el('input'),required=el('input');
      use.type='checkbox';required.type='checkbox';use.name='intake-use-'+field.key;required.name='intake-required-'+field.key;
      const assigned=draft?.fields.find(f=>f.key===field.key);
      use.checked=!!assigned;required.checked=!!assigned?.required;required.disabled=!use.checked;
      use.onchange=()=>{required.disabled=!use.checked;if(!use.checked)required.checked=false;};
      return add(checks,el('legend',field.label),add(el('label'),use,document.createTextNode(' Include '+field.label)),
        add(el('label'),required,document.createTextNode(' Require '+field.label)));
    });
    rightsForm(section,formPath+'save',groups,data=>({expectedRevision:revision,fields:model.options.flatMap(({key})=>
      Object.hasOwn(data,'intake-use-'+key)?[{key,required:Object.hasOwn(data,'intake-required-'+key)}]:[])}),'Save intake form draft');
  }
  if(allowed.includes('submit'))rightsForm(section,formPath+'submit',[],()=>({expectedRevision:revision}),'Submit intake form for review');
  if(allowed.includes('return')){
    const reasons=model.returnReasons.map(value=>({value,label:value.replaceAll('-',' ')}));
    rightsForm(section,formPath+'return',[rightsSelect('Reason to return intake form','reason',reasons)],
      data=>({expectedRevision:revision,reason:data.reason}),'Return intake form');
  }
  if(allowed.includes('publish')){
    const confirm=el('input');confirm.type='checkbox';confirm.required=true;
    rightsForm(section,formPath+'publish',[add(el('label'),confirm,document.createTextNode(' Confirm publishing this exact fictional form.'))],
      ()=>({expectedRevision:revision}),'Publish intake form');
  }
  if(model.history.length){
    const history=add(el('ol',undefined,'log'));
    for(const entry of model.history.slice().reverse()){
      const row=el('li','Version '+entry.number+' · Published by '+entry.approvedBy);
      const fields=el('ul');
      for(const field of entry.fields)fields.append(el('li',model.options.find(x=>x.key===field.key).label+
        (field.required?' · Required':' · Optional')));
      history.append(add(row,fields));
    }
    section.append(add(el('details'),el('summary','Published form history'),history));
  }
  return section;
}
function renderRights(){
  const {cases,kinds,owners,policy,legacyRecords,delegation,intakeSettings}=rightsData;
  const ownerName=id=>state?.actors.find(o=>o.id===id)?.name??owners.find(o=>o.id===id)?.name??id;
  const ownerOptions=owners.map(o=>({value:o.id,label:o.name}));
  const intro=add(el('section'),heading('Privacy rights cases'),
    el('p','Use fictional notes only. Identity review is simulated and no information is delivered.'),
    el('p','Due dates follow the applicable synthetic rule at intake. These simulations provide no legal guidance.','hint'));
  if(actor==='analyst'){
    const days=labelled('Days to respond','days',String(policy.defaultDays),'input');
    const field=days.querySelector('input');
    field.type='number';field.min=policy.min;field.max=policy.max;field.step='1';
    rightsForm(intro,rightsPath,[
      rightsSelect('Request type','kind',kinds.map(value=>({value,label:kindLabel(value)}))),
      rightsSelect('Assigned owner','owner',ownerOptions),...(policy.activeVersion===1?[days]:[]),rightsNote('Fictional intake note')
    ],v=>Object.hasOwn(v,'days')?({...v,days:Number(v.days)}):v,'Open rights case');
  }
  const list=add(el('section'),heading('Case queue'));
  if(!cases.length)list.append(el('p','No rights cases yet.'));
  for(const row of cases.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',kindLabel(row.kind)+' case'),badge(row.status.replaceAll('-',' '))),
      el('p','Case ID: '+row.id,'hint'),el('p','Assigned owner: '+ownerName(row.owner)),
      el('p','Due: '+row.dueDate+' (UTC)'+(row.overdue?' · overdue':''),row.overdue?'error':'hint'),
      el('p','Identity: '+row.identity.status.replaceAll('-',' ')),el('p',row.summary));
    card.id='work-record-'+row.id;
    renderRightsDeadlineCase(card,row);
    if(row.requesterIntake){
      const pin=add(el('details'),el('summary','Requester form version '+row.requesterIntake.version));
      const answers=el('dl');
      for(const [key,value] of Object.entries(row.requesterIntake.answers)){
        const label=intakeSettings?.options.find(f=>f.key===key)?.label??key;
        add(answers,el('dt',label),el('dd',typeof value==='boolean'?(value?'Yes':'No'):String(value)));
      }
      pin.append(answers);card.append(pin);
    }
    if(actor==='analyst')renderCaseDelegation(card,row,delegation);
    if(row.identity.reviewedBy)card.append(el('p','Identity reviewed by: '+ownerName(row.identity.reviewedBy),'hint'));
    if(row.completion)card.append(el('p','Mock fulfillment only. No data released. '+row.completion.note,'success'));
    if(row.status==='closed-unverified')card.append(el('p','Closed without disclosure.'));
    function action(name){
      const panel=add(el('details'),el('summary',rightActionLabel[name]));
      const fields=[];
      if(name==='assign')fields.push(rightsSelect('New owner','owner',ownerOptions.filter(o=>o.value!==row.owner)));
      fields.push(rightsNote('Fictional action note'));
      rightsForm(panel,rightsPath+'/'+encodeURIComponent(row.id)+'/'+name,fields,values=>({...values,expectedRevision:row.revision}),rightActionLabel[name]);
      card.append(panel);
    }
    if(!row.closedAt){
      if(actor==='analyst')action('assign');
      if(actor==='reviewer'&&row.status==='received'&&row.identity.status!=='verified'){
        action('verify');
        if(row.identity.status==='pending')action('deny-verification');
      }
      if(actor===row.owner){
        if(row.identity.status==='verified')action(row.status==='received'?'begin':'fulfill');
        if(row.identity.status==='not-verified')action('close-unverified');
      }
    }
    const history=el('ol',undefined,'log');
    for(const entry of row.history.slice().reverse()){
      const what=entry.action.replace('rights.case.','').replaceAll('-',' ');
      const detail=entry.details.note??entry.details.code??'';
      history.append(el('li',what+' · '+ownerName(entry.actor)+' · '+entry.at+(detail?' · '+detail:'')));
    }
    card.append(add(el('details'),el('summary','Case history ('+row.history.length+')'),history));
    list.append(card);
  }
  const parts=[intro,...(localSession?.authenticated&&['analyst','reviewer'].includes(actor)?[rightsDeadlinePanel()]:[]),...(intakeSettings?[requesterIntakePanel(intakeSettings)]:[]),list];
  if(legacyRecords.length){
    const archive=add(el('section'),heading('Legacy register entries'),
      el('p','These entries did not use the independent identity workflow and do not establish a verification or fulfillment outcome.'));
    for(const row of legacyRecords)archive.append(el('p',row.title+' · '+row.status));
    parts.push(archive);
  }
  rightsPane.replaceChildren(...parts);
  focusWorkRecord('rights');
}

$('#show-rights').onclick=()=>switchView('rights');
$('#actor').addEventListener('change',()=>{if(!rightsPane.hidden&&rightsData)renderRights()});
