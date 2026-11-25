'use strict';

let rightsData,rightsViewVersion,rightsSequence=0;
const rightsViewHeader='X-MVW-Rights-View-Version';
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
const readRights=(path,options)=>read(path,options,(model,response)=>({
  model,version:response.headers.get(rightsViewHeader),minimal:response.headers.get('Preference-Applied')==='return=minimal'
}));
function fullRights({model,version}){
  rightsData=model;rightsViewVersion=version;
}
function offerRightsReload(message,resultCase){
  notice(message,true);
  const retry=button('Reload cases','button','secondary');
  retry.onclick=async()=>{notice('');await refreshRights();restoreRequesterResultFocus(resultCase);};
  $('#notice').append(document.createTextNode(' '),retry);
  if(resultCase)retry.focus();
}
async function refreshRights(){
  const sequence=++rightsSequence;
  try{
    const next=await readRights(rightsPath);
    if(sequence===rightsSequence&&!rightsPane.hidden){fullRights(next);renderRights();return true;}
  }catch(e){
    if(sequence===rightsSequence&&!rightsPane.hidden){
      rightsViewVersion=null;
      rightsPane.replaceChildren(el('p','Privacy rights cases could not be loaded.'));
      offerRightsReload(e.message);
    }
  }
  return false;
}
function appendRightsIntake(response,knownVersion){
  const {case:row,delegation,baseVersion}=response.model;
  const listing=$('#rights-case-list'),visibleCases=rightsData?.cases;
  if(!knownVersion||!response.version||knownVersion!==baseVersion||rightsViewVersion!==knownVersion||
    !row?.id||!listing||!Array.isArray(visibleCases)||visibleCases.some(x=>x.id===row.id)||
    (delegation&&(!rightsData.delegation||delegation.id!==row.id)))return false;
  visibleCases.push(row);
  if(delegation)rightsData.delegation.cases.push(delegation);
  rightsViewVersion=response.version;
  $('#rights-case-empty')?.remove();
  listing.querySelector('h2').after(renderRightsCase(row));
  return true;
}
function restoreRequesterResultFocus(caseId){
  if(!caseId||rightsPane.hidden)return;
  const card=document.getElementById('work-record-'+caseId);
  const panel=card?.querySelector('[data-requester-result]');
  if(panel){
    panel.open=true;
    panel.querySelector('summary').focus();
  }else{
    const title=card?.querySelector('h3');
    if(title){title.tabIndex=-1;title.focus();}
  }
}
function rightsForm(target,path,fields,requestBody,caption){
  const form=add(el('form'),...fields,button(caption,'submit'));
  const resultCase=target.dataset.requesterResult;
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy)return;
    busy=true;
    const attempt=++rightsSequence,submit=form.querySelector('button'),intake=path===rightsPath;
    const knownVersion=intake&&localSession?.authenticated?rightsViewVersion:null;
    let requireReload=false;
    submit.disabled=true;
    try {
      const values=Object.fromEntries(new FormData(form));
      const response=await readRights(path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor,
        ...(knownVersion?{Prefer:'return=minimal',[rightsViewHeader]:knownVersion}:{})},body:JSON.stringify(requestBody(values))});
      if(!intake){
        fullRights(response);
        if(!rightsPane.hidden){renderRights();notice('Privacy rights case updated.');restoreRequesterResultFocus(resultCase);}
        return;
      }
      if(rightsPane.hidden)return;
      if(attempt===rightsSequence&&response.minimal&&appendRightsIntake(response,knownVersion)){
        form.reset();notice('Privacy rights case updated.');
      }else if(attempt===rightsSequence&&!response.minimal&&Array.isArray(response.model?.cases)){
        fullRights(response);renderRights();notice('Privacy rights case updated.');
      }else{
        // A committed intake is never posted again to recover its UI. Refresh
        // the currently authorized list if the local view moved while it ran.
        if(await refreshRights())notice('Privacy rights case updated.');
        else if(!rightsPane.hidden)offerRightsReload('Case opened. Reload cases before continuing.');
      }
    }catch(err){
      if(!rightsPane.hidden){
        if(intake&&(!err.status||err.status>=500)){
          rightsViewVersion=null;requireReload=true;
          offerRightsReload('The intake result could not be confirmed. Reload cases before submitting again.');
        }else if(err.status===409&&err.message.includes('Reload'))offerRightsReload(err.message,resultCase);
        else notice(err.message,true);
      }
    }finally{busy=false;submit.disabled=requireReload;}
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
function renderRequesterResult(card,row){
  const model=row.resultDelivery;
  if(!model)return;
  const panel=add(el('details'),el('summary','Fictional requester result'),
    el('p','Stage: '+model.stage.replaceAll('-',' ')),
    el('p','Only fixed fictional categories and counts can appear. Approval alone does not release anything.','hint'));
  panel.dataset.requesterResult=row.id;
  if(model.preview)panel.append(el('h4','Redacted preview · version '+model.version),
    add(el('ul'),...model.preview.sections.map(item=>el('li',item.label+': '+item.count))));
  const root=rightsPath+'/'+encodeURIComponent(row.id)+'/result/';
  const revision=()=>({expectedRevision:model.version,digest:model.digest});
  if(model.actions.includes('draft')){
    const options=model.selections.map(({id,label})=>({value:id,label}));
    rightsForm(panel,root+'draft',[rightsSelect('Fictional result projection','selection',options,model.selection)],
      ({selection})=>({expectedRevision:model.version,selection}),'Save redacted result draft');
  }
  const labels={submit:'Submit exact result for review',approve:'Approve this exact result',return:'Return result for changes'};
  for(const action of ['submit','approve','return'])
    if(model.actions.includes(action))rightsForm(panel,root+action,[],revision,labels[action]);
  if(model.actions.includes('release')){
    const confirmation=el('input');confirmation.type='checkbox';confirmation.required=true;
    const label=add(el('label'),confirmation,document.createTextNode(' Confirm release to the original synthetic code.'));
    rightsForm(panel,root+'release',[label],()=>({...revision(),confirm:true}),'Release approved result locally');
  }
  card.append(panel);
}
function renderRightsRetrieval(card,row){
  if(row.retrievalOffered!==true||!localSession?.authenticated||!['analyst','reviewer'].includes(actor))return;
  const summary=el('summary','Internal fictional retrieval');
  const contents=el('div');
  contents.setAttribute('aria-live','polite');
  const panel=add(el('details'),summary,contents);
  const route=rightsPath+'/'+encodeURIComponent(row.id)+'/retrieval';
  const knownStages={'not-retrieved':'Not retrieved',draft:'Redacted draft',review:'Awaiting independent review',
    returned:'Returned for rework',approved:'Approved for internal rehearsal only',stale:'Stale case revision'};
  const labels={retrieve:'Retrieve fictional category counts',submit:'Submit exact retrieval for review',
    return:'Return retrieval for rework',approve:'Approve this exact retrieval'};
  const categories={preference:'Fictional preference examples',service:'Fictional service examples'};
  let epoch=0,pending=false;
  const active=ticket=>epoch===ticket&&panel.isConnected&&panel.open&&!rightsPane.hidden;
  function recovering(error,focus){
    const message=error.status===409?'The case or retrieval changed. Reload before retrying.':
      error.status===404?'No fictional retrieval is available for this case or review stage.':
      'The retrieval could not be confirmed. Reload before retrying.';
    const retry=button('Reload retrieval','button','secondary');
    retry.onclick=()=>load(true);
    contents.replaceChildren(el('p',message,'error'),retry);
    if(focus)retry.focus();
  }
  function render(model){
    if(model?.mode!=='synthetic-rights-retrieval'||!Object.hasOwn(knownStages,model.stage)||
      !Number.isSafeInteger(model.revision)||model.revision<0||
      (model.caseId!==undefined&&model.caseId!==row.id))throw Error('Unexpected retrieval model.');
    contents.replaceChildren(el('p',knownStages[model.stage]),
      el('p','Retrieval revision '+model.revision+(Number.isSafeInteger(model.caseRevision)?' · Case revision '+model.caseRevision:''),'hint'),
      el('p','Fixed category counts only. This internal exercise does not release anything to the requester.','hint'));
    if(model.projection){
      const output=model.projection,items=output.categories;
      if(output.schemaVersion!==1||!Array.isArray(items)||!items.length||items.length>2||
        !items.every(item=>item&&Object.hasOwn(categories,item.category)&&Number.isSafeInteger(item.count)&&item.count>0&&item.count<=4)||
        new Set(items.map(item=>item.category)).size!==items.length||
        items.reduce((sum,item)=>sum+item.count,0)!==output.rowsReviewed)
        throw Error('Unexpected retrieval projection.');
      contents.append(el('h4','Redacted category counts'),
        add(el('ul'),...items.map(item=>el('li',categories[item.category]+': '+item.count))));
    }
    for(const action of model.actions??[]){
      if(!Object.hasOwn(labels,action)||
        (actor==='analyst'&&!['retrieve','submit'].includes(action))||
        (actor==='reviewer'&&!['return','approve'].includes(action)))continue;
      const control=button(labels[action]);
      control.onclick=()=>mutate(action,model);
      contents.append(control);
    }
  }
  async function load(restoreFocus=false){
    const ticket=++epoch;
    contents.replaceChildren(el('p','Loading fictional retrieval…','hint'));
    contents.setAttribute('aria-busy','true');
    try{
      const model=await read(route);
      if(active(ticket)){render(model);if(restoreFocus)summary.focus();}
    }catch(error){if(active(ticket))recovering(error,restoreFocus);}
    finally{if(active(ticket))contents.removeAttribute('aria-busy');}
  }
  async function mutate(action,model){
    if(pending||busy||!panel.open)return;
    const ticket=++epoch;
    pending=true;busy=true;
    contents.replaceChildren(el('p','Checking the exact fictional retrieval revision…','hint'));
    contents.setAttribute('aria-busy','true');
    try{
      const data={expectedCaseRevision:model.caseRevision,expectedRevision:model.revision,
        ...(action==='retrieve'?{source:model.source}:{digest:model.digest})};
      const next=await read(route+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      if(active(ticket)){render(next);summary.focus();}
    }catch(error){if(active(ticket))recovering(error,true);}
    finally{pending=false;busy=false;if(active(ticket))contents.removeAttribute('aria-busy');}
  }
  panel.ontoggle=()=>{
    if(panel.open){void load();return;}
    epoch++;
    contents.replaceChildren();
    contents.removeAttribute('aria-busy');
  };
  card.append(panel);
}
function renderRightsCase(row){
  const {owners,delegation,intakeSettings}=rightsData;
  const ownerName=id=>state?.actors.find(o=>o.id===id)?.name??owners.find(o=>o.id===id)?.name??id;
  const ownerOptions=owners.map(o=>({value:o.id,label:o.name}));
  const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',kindLabel(row.kind)+' case'),badge(row.status.replaceAll('-',' '))),
    el('p','Case ID: '+row.id,'hint'),el('p','Assigned owner: '+ownerName(row.owner)),
    el('p','Due: '+row.dueDate+' (UTC)'+(row.overdue?' · overdue':''),row.overdue?'error':'hint'),
    el('p','Identity: '+row.identity.status.replaceAll('-',' ')),el('p',row.summary));
  card.id='work-record-'+row.id;
  renderRightsDeadlineCase(card,row);
  renderRequesterResult(card,row);
  renderRightsRetrieval(card,row);
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
  return card;
}
function renderRights(){
  const {cases,kinds,owners,policy,legacyRecords,intakeSettings}=rightsData;
  const ownerOptions=owners.map(o=>({value:o.id,label:o.name}));
  const intro=add(el('section'),heading('Privacy rights cases'),
    el('p','Use fictional notes only. Identity review is simulated and no information is delivered.'),
    el('p','Due dates follow the applicable synthetic rule at intake. These simulations provide no legal guidance.','hint'));
  if(actor==='analyst'){
    const days=labelled('Days to respond','days',String(policy.defaultDays),'input');
    const field=days.querySelector('input');
    field.type='number';field.min=policy.min;field.max=policy.max;field.step='1';field.defaultValue=String(policy.defaultDays);
    rightsForm(intro,rightsPath,[
      rightsSelect('Request type','kind',kinds.map(value=>({value,label:kindLabel(value)}))),
      rightsSelect('Assigned owner','owner',ownerOptions),...(policy.activeVersion===1?[days]:[]),rightsNote('Fictional intake note')
    ],v=>Object.hasOwn(v,'days')?({...v,days:Number(v.days)}):v,'Open rights case');
  }
  const list=add(el('section'),heading('Case queue'));
  list.id='rights-case-list';
  if(!cases.length){const empty=el('p','No rights cases yet.');empty.id='rights-case-empty';list.append(empty);}
  for(const row of cases.slice().reverse())list.append(renderRightsCase(row));
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
