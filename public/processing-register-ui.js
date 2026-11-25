'use strict';
const processingPane=$('#processing-register-view'),processingPath='/api/processing-register';
let processingModel,processingSequence=0;
async function refreshProcessingRegister(){
  const seq=++processingSequence;
  try{
    const model=await read(processingPath);
    if(seq===processingSequence&&!processingPane.hidden){processingModel=model;renderProcessingRegister()}
  }catch(error){
    if(seq===processingSequence&&!processingPane.hidden){processingPane.replaceChildren(el('p','The processing register could not be loaded.'));notice(error.message,true)}
  }
}
async function postProcessing(path,data,control){
  if(busy)return;
  busy=true;control.disabled=true;
  const seq=++processingSequence;
  try{
    const model=await read(processingPath+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(data)});
    if(seq===processingSequence&&!processingPane.hidden){processingModel=model;renderProcessingRegister();notice('Processing register updated.')}
  }catch(error){
    if(seq===processingSequence&&!processingPane.hidden){
      notice(error.message,true);
      if(error.status===409&&/reload/i.test(error.message)){
        const retry=button('Reload processing register','button','secondary');retry.onclick=refreshProcessingRegister;
        $('#notice').append(document.createTextNode(' '),retry);
      }
    }
  }finally{control.disabled=false;busy=false}
}
function processingPicker(label,name,values,selected,disabled=false){
  const field=el('select');field.name=name;field.required=true;field.disabled=disabled;field.setAttribute('aria-label',label);
  const blank=el('option','Select an option');blank.value='';field.append(blank);
  for(const [value,text] of values){const option=el('option',text);option.value=value;field.append(option)}
  field.value=selected??'';return add(el('label',label),field);
}
function processingChecklist(title,name,values,selected=[]){
  const fieldset=add(el('fieldset',undefined,'processing-checklist'),el('legend',title));
  for(const [value,text] of values){
    const field=el('input');field.type='checkbox';field.name=name;field.value=value;field.checked=selected.includes(value);
    fieldset.append(add(el('label'),field,document.createTextNode(' '+text)));
  }
  for(const id of selected.filter(id=>!values.some(([key])=>key===id)))
    fieldset.append(el('p','Prior selection is no longer eligible. Choose an eligible replacement.','hint'));
  return fieldset;
}
function processingForm(current,submitLabel,path,revision,dirty=()=>{}){
  const {vocabulary,options}=processingModel;
  const fields=el('form'),recipientArea=el('div'),recipientRows=[];
  function recipient(item={}){
    const box=add(el('fieldset',undefined,'processing-recipient'),el('legend','Fictional recipient'));
    const type=processingPicker('Recipient type','type',Object.entries(vocabulary.recipientTypes),item.type??'processor');
    const label=labelled('Recipient label','label',item.label??'','input');
    const dest=processingPicker('Destination','destination',Object.entries(vocabulary.destinations),item.destination??'sameRegion');
    const safeguards=labelled('Transfer safeguards','safeguards',item.safeguards??'','textarea',false);
    safeguards.querySelector('textarea').maxLength=500;
    const sync=()=>{safeguards.querySelector('textarea').required=dest.querySelector('select').value==='otherRegion'};
    dest.onchange=sync;sync();
    const remove=button('Remove recipient','button','secondary');
    const entry={read:()=>({
      type:type.querySelector('select').value,label:label.querySelector('input').value,destination:dest.querySelector('select').value,
      safeguards:safeguards.querySelector('textarea').value
    })};
    remove.onclick=()=>{recipientRows.splice(recipientRows.indexOf(entry),1);box.remove();append.disabled=false;dirty()};
    box.append(add(el('div',undefined,'processing-grid'),type,label,dest),safeguards,remove);recipientArea.append(box);
    recipientRows.push(entry);
  }
  const activity=processingPicker('Mapped activity','activityId',options.nodes.filter(x=>x.type==='activity').map(n=>[n.id,n.name]),current?.activityId,!!current);
  const title=labelled('Entry title','title',current?.title??'','input');title.querySelector('input').maxLength=160;
  const purpose=labelled('Fictional processing purpose','purpose',current?.purpose??'');purpose.querySelector('textarea').maxLength=1500;
  const roles=Object.entries(vocabulary.roles),append=button('Add recipient','button','secondary');
  for(const row of current?.recipients??[])recipient(row);
  append.disabled=recipientRows.length>=12;
  append.onclick=()=>{recipient();append.disabled=recipientRows.length>=12;dirty()};
  const topology=el('div',undefined,'processing-grid');
  const picker=activity.querySelector('select');
  function refreshLineage(){
    const activityId=current?.activityId??picker.value;
    const currentValues=new FormData(fields);
    const selectedSystems=topology.children.length?currentValues.getAll('systems'):current?.systems;
    const selectedDatasets=topology.children.length?currentValues.getAll('datasets'):current?.datasets;
    const datasets=new Set(options.links.flatMap(x=>x.toId===activityId&&x.type==='reads'?[x.fromId]:
      x.fromId===activityId&&x.type==='writes'?[x.toId]:[]));
    const systems=new Set(options.links.filter(x=>x.type==='hosts'&&datasets.has(x.toId)).map(x=>x.fromId));
    topology.replaceChildren(processingChecklist('Systems','systems',options.nodes.filter(x=>systems.has(x.id)).map(n=>[n.id,n.name]),selectedSystems),
      processingChecklist('Datasets','datasets',options.nodes.filter(x=>datasets.has(x.id)).map(n=>[n.id,n.name]),selectedDatasets));
    if(activityId&&(!datasets.size||!systems.size))
      topology.append(el('p','Use Data mapping to link this activity to a dataset and its hosting system.','hint'));
  }
  picker.onchange=refreshLineage;
  const save=button(submitLabel,'submit');
  fields.append(title,purpose,add(el('div',undefined,'processing-grid'),
    processingPicker('Accountable role','ownerRole',roles,current?.ownerRole),
    processingPicker('Steward role','stewardRole',roles,current?.stewardRole),activity),topology,
    add(el('div',undefined,'processing-grid'),
      processingChecklist('Subject categories','subjects',Object.entries(vocabulary.subjects),current?.subjects),
      processingChecklist('Data categories','dataCategories',Object.entries(vocabulary.categories),current?.dataCategories),
      processingChecklist('Approved dictionary references','terms',options.terms.map(x=>[x.id,x.title+' · '+x.type+' · v'+x.version]),current?.terms),
      processingChecklist('Active retention references','retentionSchedules',options.schedules.map(x=>[x.id,x.title+' · v'+x.version]),current?.retentionSchedules)),
    add(el('div'),el('h4','Recipients and transfers'),el('p','Leave blank if there are no disclosures or mapped outgoing transfers.','hint'),recipientArea,append),save);
  refreshLineage();
  fields.oninput=dirty;fields.onchange=dirty;
  fields.onsubmit=e=>{
    e.preventDefault();
    const data=new FormData(fields);
    const details=Object.fromEntries(['title','purpose','ownerRole','stewardRole','activityId'].map(k=>[k,k==='activityId'&&current?current.activityId:data.get(k)]));
    for(const k of ['systems','datasets','terms','retentionSchedules','subjects','dataCategories'])details[k]=data.getAll(k);
    details.recipients=recipientRows.map(x=>x.read());
    postProcessing(path,{details,...(revision===undefined?{}:{expectedRevision:revision})},save);
  };
  return fields;
}
function processingSummary(snapshot){
  const section=el('div',undefined,'processing-summary');
  const line=(label,text)=>section.append(add(el('div'),el('strong',label),el('p',text)));
  line('Purpose',snapshot.purpose);
  line('Accountability',snapshot.accountableRole+' · Steward: '+snapshot.stewardRole);
  line('Mapped activity',snapshot.activity.name);
  line('Systems',snapshot.systems.map(x=>x.name).join(', '));
  line('Datasets',snapshot.datasets.map(x=>x.name).join(', '));
  line('Subject categories',snapshot.subjects.join(', '));
  line('Data categories',snapshot.dataCategories.join(', '));
  line('Dictionary',snapshot.dictionaryTerms.map(x=>x.title+' v'+x.version).join(', '));
  line('Retention',snapshot.retentionSchedules.map(x=>x.title+' v'+x.version+' · '+x.days+' days').join(', '));
  if(snapshot.transferTargets.length)line('Mapped transfer targets',snapshot.transferTargets.map(x=>x.name).join(', '));
  section.append(el('h4','Recipients'));
  if(!snapshot.recipients.length)section.append(el('p','No recipients recorded.','hint'));
  for(const r of snapshot.recipients)section.append(el('p',r.label+' · '+r.type+' · '+r.destination+(r.safeguards?' · '+r.safeguards:'')));
  return section;
}
function processingDownload(path,caption){
  const download=el('a',caption,'button quiet');download.href=scopeUrl(processingPath+path);download.download='';return download;
}
function renderProcessingRegister(){
  const {entries,options}=processingModel;
  const intro=add(el('section'),el('p','DATA GOVERNANCE','eyebrow'),heading('Processing register'),
    el('p','Review how fictional data is processed, where it goes, and which approved terms and retention schedules apply.'),
    processingDownload('/export','Download current approved register'));
  processingPane.replaceChildren(intro);
  if(actor==='analyst'){
    const prerequisites=options.nodes.some(n=>n.type==='activity')&&options.terms.some(t=>t.type==='purpose')&&options.schedules.length;
    if(prerequisites){
      intro.append(add(el('details'),el('summary','Draft processing entry'),processingForm(null,'Create processing draft','/entries')));
    }else{
      intro.append(el('p','To draft an entry, create a linked activity in Data mapping, approve a purpose in Data dictionary, and activate a Retention schedule.','hint'));
      for(const [view,label] of [['data-map','Open Data mapping'],['dictionary','Open Data dictionary'],['retention','Open Retention']]){
        const nav=button(label,'button','secondary');nav.onclick=()=>switchView(view);intro.append(nav);
      }
    }
  }
  if(!entries.length)processingPane.append(add(el('section'),el('p','No processing entries yet.','hint')));
  for(const record of entries.slice().reverse()){
    const revision=record.revision,latest=record.versions.at(-1),published=record.versions.findLast(v=>v.status==='published');
    const path='/entries/'+record.id,card=add(el('section',undefined,'processing-card'),
      add(el('div',undefined,'row'),el('h3',latest.snapshot.title),badge(latest.status)),
      el('p','Version '+latest.version+' · Revision '+revision+(published?' · Current approved v'+published.version:''),'hint'),processingSummary(latest.snapshot));
    if(latest.decision)card.append(el('p','Reviewer '+latest.decision.account+': '+latest.decision.note,'hint'));
    if(actor==='analyst'&&['draft','returned'].includes(latest.status)){
      const submit=button('Submit processing entry','button','secondary');
      submit.onclick=()=>postProcessing(path+'/submit',{expectedRevision:revision},submit);
      const edit=processingForm(latest.details,'Save processing changes',path+'/edit',revision,()=>{submit.disabled=true;submit.title='Save changes before submitting'});
      card.append(add(el('details'),el('summary','Edit draft processing entry'),edit),submit);
    }else if(actor==='analyst'&&latest.status==='published'){
      const revise=button('Draft next processing version','button','secondary');
      revise.onclick=()=>postProcessing(path+'/revise',{expectedRevision:revision},revise);card.append(revise);
    }
    if(actor==='reviewer'&&latest.status==='in_review'){
      const form=el('form'),note=labelled('Independent processing review note','note',''),
        approve=button('Approve and publish entry','submit'),returnButton=button('Return processing entry','submit','secondary');
      note.querySelector('textarea').maxLength=500;
      form.append(note,add(el('div',undefined,'actions'),approve,returnButton));card.append(form);
      form.onsubmit=e=>{e.preventDefault();postProcessing(path+(e.submitter===returnButton?'/return':'/publish'),
        {expectedRevision:revision,note:new FormData(form).get('note')},e.submitter??approve)};
    }
    const history=add(el('details'),el('summary','Approved version history'));
    for(const version of record.versions.filter(v=>v.status==='published').reverse())
      history.append(add(el('div',undefined,'processing-edition'),el('p','v'+version.version+' · '+version.snapshot.title+' · '+version.decision.at,'hint'),
        processingDownload(path+'/versions/'+version.version+'/export','Download approved version '+version.version)));
    if(!published)history.append(el('p','No approved version yet.','hint'));
    card.append(history);processingPane.append(card);
  }
}
$('#show-processing-register').onclick=()=>switchView('processing-register');
$('#actor').addEventListener('change',()=>{if(!processingPane.hidden&&processingModel)renderProcessingRegister()});
