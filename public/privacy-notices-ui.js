'use strict';

const prefsPane=$('#preferences-view'),prefsPath='/api/privacy-notices';
let prefsData;
const prefLabels={web:'Web',mobile:'Mobile','connected-tv':'Connected TV','service-desk':'Service desk'};
const prefOptions=values=>values.map(value=>({value,label:prefLabels[value]??value}));
async function refreshPreferences(){
  try{
    prefsData=await read(prefsPath);
    if(!prefsPane.hidden)renderPreferences();
  }catch(error){
    if(!prefsPane.hidden){prefsPane.replaceChildren(el('p','Privacy notices could not be loaded.'));notice(error.message,true)}
  }
}
function prefsForm(parent,url,fields,caption,payload,onSuccess){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy)return;
    busy=true;const submit=form.querySelector('button');submit.disabled=true;
    try{
      const data=await read(prefsPath+url,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},
        body:JSON.stringify(payload(new FormData(form)))});
      if(!prefsPane.hidden)onSuccess(data);
      elseprefsData=data;
    }catch(error){
      if(!prefsPane.hidden){
        notice(error.message,true);
        if(error.status===409&&error.message.includes('Reload')){
          const reload=button('Reload notices','button','secondary');
          reload.onclick=async()=>{notice('');await refreshPreferences()};
          $('#notice').append(document.createTextNode(' '),reload);
        }
      }
    }finally{busy=false;submit.disabled=false}
  };
  parent.append(form);
  return form;
}
function prefsSave(parent,url,fields,caption,formPayload,revision){
  return prefsForm(parent,url,fields,caption,f=>({...formPayload(f),expectedRevision:revision}),data=>{
    prefsData=data;renderPreferences();notice('Privacy notices updated.');
  });
}
function noticeFields(n){
  const content=labelled('Fictional notice text','content',n?.content??'');
  content.querySelector('textarea').maxLength=4000;
  return [labelled('Fictional notice title','title',n?.title??'','input'),content];
}
function noticePayload(form){return {title:form.get('title'),content:form.get('content')}}
function renderPreferences(){
  const {channels,notices,legacyRecords,revision}=prefsData;
  const current=new Map();
  for(const n of notices)if(n.status==='published')current.set(n.scope+'|'+n.channel,n);
  const intro=add(el('section'),heading('Privacy notices'),
    el('p','Draft and review fictional notices. Publication is local only.'));
  if(actor==='analyst'){
    const editor=add(el('details'),el('summary','Draft privacy notice'));
    prefsSave(editor,'/notices',[labelled('Fictional scope such as synthetic-portal','scope','','input'),rightsSelect('Notice channel','channel',prefOptions(channels)),
      ...noticeFields()],'Create draft',f=>({scope:f.get('scope'),channel:f.get('channel'),...noticePayload(f)}),revision);
    intro.append(editor);
  }
  const versions=add(el('section'),heading('Notice revision history'));
  if(!notices.length)versions.append(el('p','No privacy notices yet.'));
  for(const n of notices.slice().reverse()){
    const isCurrent=current.get(n.scope+'|'+n.channel)?.id===n.id;
    const card=add(el('article',undefined,'module-record'),
      add(el('div',undefined,'row'),el('h3',n.title),badge(n.status+(isCurrent?' · current':''))),
      el('p',n.scope+' · '+prefLabels[n.channel]+' · Revision '+n.version,'hint'),
      el('p',n.content,'policy-copy'));
    card.id='work-record-'+n.id;
    if(n.reviewNote)card.append(el('p','Reviewer: '+n.reviewNote,'hint'));
    if(n.publishedAt)card.append(el('p','Locally published '+n.publishedAt+' by '+n.publishedBy,'hint'));
    const path='/notices/'+n.id+'/';
    if(actor==='analyst'&&n.status==='draft'){
      const editor=add(el('details'),el('summary','Edit draft'));
      prefsSave(editor,path+'edit',noticeFields(n),'Save draft',noticePayload,revision);
      card.append(editor);
      prefsSave(card,path+'submit',[],'Submit for independent review',()=>({}),revision);
    }
    if(actor==='reviewer'&&n.status==='review'){
      for(const [action,label] of [['publish','Publish locally'],['return','Return to draft']]){
        const panel=add(el('details'),el('summary',label));
        prefsSave(panel,path+action,[rightsNote('Fictional reviewer rationale')],label,f=>Object.fromEntries(f),revision);
        card.append(panel);
      }
    }
    versions.append(card);
  }
  const panels=[intro,versions];
  if(legacyRecords.length){
    const legacy=add(el('section'),heading('Legacy records'),el('p','Historical records are separate from the versioned notice workflow.'));
    for(const row of legacyRecords)legacy.append(el('p',row.title+' · '+row.status));
    panels.push(legacy);
  }
  prefsPane.replaceChildren(...panels);
  focusWorkRecord('preferences');
}
$('#show-preferences').onclick=()=>switchView('preferences');
$('#actor').addEventListener('change',()=>{if(!prefsPane.hidden&&prefsData)renderPreferences()});
