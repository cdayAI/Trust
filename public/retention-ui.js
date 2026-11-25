'use strict';
const retentionPane=$('#retention-view'),retentionPath='/api/retention';
let retentionData;
const retentionOptions=xs=>xs.map(value=>({value,label:value.replaceAll('-',' ')}));
const retentionReason={ACTIVE_HOLD:'An active hold blocks disposition',NO_ACTIVE_SCHEDULE:'No active schedule',TRIGGER_NOT_RECORDED:'Trigger date is absent',
  BEFORE_DUE_DATE:'Not yet due',ELIGIBLE:'Eligible for audit-only simulation'};

async function refreshRetention(){
  try{
    retentionData=await read(retentionPath);
    if(!retentionPane.hidden)renderRetention();
  }catch(e){
    if(!retentionPane.hidden){retentionPane.replaceChildren(el('p','Retention could not be loaded.'));notice(e.message,true)}
  }
}
function retentionForm(parent,url,fields,caption,revision,numberFields=[]){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy)return;
    busy=true;const submit=form.querySelector('button');submit.disabled=true;
    try{
      const body={...Object.fromEntries(new FormData(form)),expectedRevision:revision};
      for(const field of numberFields)body[field]=Number(body[field]);
      retentionData=await read(retentionPath+url,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
      if(!retentionPane.hidden){renderRetention();notice('Retention simulation workspace updated.')}
    }catch(error){
      if(!retentionPane.hidden){
        notice(error.message,true);
        if(error.status===409&&error.message.includes('Reload')){
          const b=button('Reload retention','button','secondary');
          b.onclick=async()=>{notice('');await refreshRetention()};
          $('#notice').append(document.createTextNode(' '),b);
        }
      }
    }finally{busy=false;submit.disabled=false}
  };
  parent.append(form);
}
function retentionField(label,name,value,type,required=true){
  const l=labelled(label,name,value,'input',required);
  l.querySelector('input').type=type;
  return l;
}
function renderRetention(){
  const {revision,categories,triggerTypes,dispositions,current,schedules,records,holds,previews,runs,legacyRecords}=retentionData;
  const analyst=actor==='analyst',reviewer=actor==='reviewer';
  const intro=add(el('section'),heading('Retention and holds'),el('p','Local fictional fixtures and UTC calendar days only. Audit-only simulation never deletes or modifies a record.'));
  const schedulePanel=add(el('section'),heading('Versioned retention schedules'));
  function fields(row){
    const days=retentionField('Retention days','days',String(row?.days??30),'number');
    const input=days.querySelector('input');input.min=1;input.max=36500;input.step=1;
    return [labelled('Fictional schedule title','title',row?.title??'','input'),
      rightsSelect('Date trigger','trigger',retentionOptions(triggerTypes),row?.trigger),days,
      rightsSelect('Simulated disposition','disposition',retentionOptions(dispositions),row?.disposition)];
  }
  if(analyst){
    const f=add(el('details'),el('summary','Draft a schedule'));
    retentionForm(f,'/schedules',[rightsSelect('Category','category',retentionOptions(categories)),...fields(null)],'Create draft',revision,['days']);
    schedulePanel.append(f);
  }
  if(!schedules.length)schedulePanel.append(el('p','No fictional schedules.'));
  for(const row of schedules.slice().reverse()){
    const status=row.status==='active'?(current[row.category]===row.id?'Current':'Historical activated'):row.status;
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',row.title),badge(status)),
      el('p',row.category+' · v'+row.version+' · '+row.days+' days from '+row.trigger+' · '+row.disposition,'hint'));
    card.id='work-record-'+row.id;
    if(row.reviewNote)card.append(el('p','Review: '+row.reviewNote));
    if(analyst&&row.status==='draft'){
      const editor=add(el('details'),el('summary','Edit schedule'));
      retentionForm(editor,'/schedules/'+row.id+'/edit',fields(row),'Save schedule',revision,['days']);
      card.append(editor);
      retentionForm(card,'/schedules/'+row.id+'/submit',[],'Submit schedule',revision);
    }
    if(reviewer&&row.status==='review'){
      for(const [action,label] of [['activate','Activate schedule'],['return','Return to draft']]){
        const panel=add(el('details'),el('summary',label));
        retentionForm(panel,'/schedules/'+row.id+'/'+action,[rightsNote('Fictional review note')],label,revision);
        card.append(panel);
      }
    }
    schedulePanel.append(card);
  }
  const recordPanel=add(el('section'),heading('Fictional record fixtures'));
  if(analyst){
    const editor=add(el('details'),el('summary','Add fixture'));
    retentionForm(editor,'/records',[labelled('Fixture ID such as SYN-RECORD01','reference','','input'),
      rightsSelect('Fixture category','category',retentionOptions(categories)),retentionField('Created UTC date','createdOn','','date'),
      retentionField('Closed UTC date (optional)','closedOn','','date',false)],'Add fixture',revision);
    recordPanel.append(editor);
  }
  if(!records.length)recordPanel.append(el('p','No fictional records.'));
  const holdsByRecord=new Map(records.map(r=>[r.id,[]]));
  for(const h of holds)holdsByRecord.get(h.recordId)?.push(h);
  for(const row of records.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),el('h3',row.reference),el('p',row.category+' · Created '+row.createdOn+(row.closedOn?' · Closed '+row.closedOn:''),'hint'));
    for(const hold of holdsByRecord.get(row.id)){
      card.append(el('p',(hold.releasedAt?'Released hold: ':'Active hold: ')+hold.note));
      if(hold.releaseNote)card.append(el('p','Release note: '+hold.releaseNote,'hint'));
      if(reviewer&&!hold.releasedAt){
        const panel=add(el('details'),el('summary','Release hold'));
        retentionForm(panel,'/holds/'+hold.id+'/release',[rightsNote('Fictional release note')],'Release hold',revision);
        card.append(panel);
      }
    }
    if(analyst){
      const hidden=()=>{const field=el('input');field.type='hidden';field.name='recordId';field.value=row.id;return field};
      const hold=add(el('details'),el('summary','Add fictional hold'));
      retentionForm(hold,'/holds',[hidden(),rightsNote('Fictional hold rationale')],'Place hold',revision);
      const preview=add(el('details'),el('summary','Preview disposition'));
      retentionForm(preview,'/previews',[hidden(),retentionField('Simulation UTC date','asOf',new Date().toISOString().slice(0,10),'date')],'Save disposition preview',revision);
      card.append(hold,preview);
    }
    recordPanel.append(card);
  }
  const labels=new Map(records.map(r=>[r.id,r.reference]));
  const previewPanel=add(el('section'),heading('Disposition previews and results'));
  if(!previews.length)previewPanel.append(el('p','No saved previews.'));
  for(const row of previews.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),el('h3',labels.get(row.recordId)),el('p','Simulated date: '+row.asOf),
      el('p',retentionReason[row.reason]),el('p','Schedule: '+(row.scheduleVersion===null?'none':'v'+row.scheduleVersion)+' · Due: '+(row.dueOn??'not calculated')+
      ' · Active holds at preview: '+row.holdIds.length,'hint'));
    const run=runs.find(r=>r.previewId===row.id);
    if(run)card.append(el('p','Audit-only simulation recorded: '+run.disposition+'. No record changed.','success'));
    else if(analyst&&row.eligible)retentionForm(card,'/previews/'+row.id+'/simulate',[],'Record audit-only simulation',revision);
    previewPanel.append(card);
  }
  const sections=[intro,schedulePanel,recordPanel,previewPanel];
  if(legacyRecords.length){
    const old=add(el('section'),heading('Legacy retention register'),el('p','Historical generic entries do not drive retention decisions.'));
    for(const r of legacyRecords)old.append(el('p',r.title+' · '+r.status));
    sections.push(old);
  }
  retentionPane.replaceChildren(...sections);
  focusWorkRecord('retention');
}
$('#show-retention').onclick=()=>switchView('retention');
$('#actor').addEventListener('change',()=>{if(!retentionPane.hidden&&retentionData)renderRetention()});
