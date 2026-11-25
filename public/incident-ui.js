'use strict';
const incidentPane=$('#incident-view'),incidentsPath='/api/incidents/cases';
let incidentData;
const incAction={
  triage:'Record severity',containment:'Record containment',evidence:'Add evidence reference',
  findings:'Record investigation findings','request-review':'Request notice review',decide:'Record simulated notice decision',
  'plan-notice':'Record mock notice plan',close:'Close incident'
};
const capitalize=s=>s[0].toUpperCase()+s.slice(1).replaceAll('-',' ');
async function refreshIncidents(){
  try {
    incidentData=await read(incidentsPath);
    if(!incidentPane.hidden)renderIncidents();
  }catch(error){
    if(!incidentPane.hidden){incidentPane.replaceChildren(el('p','Incidents could not be loaded.'));notice(error.message,true)}
  }
}
function incidentForm(parent,path,fields,caption,revision){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async evt=>{
    evt.preventDefault();
    if(busy)return;
    busy=true;const save=form.querySelector('button');save.disabled=true;
    const body=Object.fromEntries(new FormData(form));
    if(revision!==undefined)body.expectedRevision=revision;
    try{
      incidentData=await read(path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
      if(!incidentPane.hidden){renderIncidents();notice('Incident updated.')}
    }catch(error){
      if(!incidentPane.hidden){
        notice(error.message,true);
        if(error.status===409&&error.message.includes('Reload')){
          const reload=button('Reload incidents','button','secondary');
          reload.onclick=async()=>{notice('');await refreshIncidents()};
          $('#notice').append(document.createTextNode(' '),reload);
        }
      }
    }finally{busy=false;save.disabled=false}
  };
  parent.append(form);
}
function renderIncidents(){
  const {cases,legacyRecords,severities,decisions,noticeName}=incidentData;
  const intro=add(el('section'),heading('Privacy incidents'),el('p','Use fictional scope, findings and reference IDs. This workbench does not make legal determinations or send notices.'));
  if(actor==='analyst')incidentForm(intro,incidentsPath,[
    labelled('Fictional incident title','title','','input'),
    labelled('Fictional affected scope','scope','')
  ],'Log incident');
  const listing=add(el('section'),heading('Incident queue'));
  if(!cases.length)listing.append(el('p','No fictional incidents.'));
  for(const row of cases.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',row.title),badge(capitalize(row.stage))),
      el('p','Incident ID: '+row.id,'hint'),el('p','Affected scope: '+row.scope));
    card.id='work-record-'+row.id;
    if(row.severity)card.append(el('p','Severity: '+capitalize(row.severity)+' · '+capitalize(row.branch)+' investigation'));
    if(row.containment)card.append(el('p','Containment: '+row.containment.note));
    if(row.findings)card.append(el('p','Findings: '+row.findings.note));
    if(row.review)card.append(el('p','Simulated notice decision: '+noticeName[row.review.decision]+'. '+row.review.note));
    if(row.noticePlan)card.append(el('p','Mock notice plan '+row.noticePlan.reference+' (not sent): '+row.noticePlan.note));
    if(row.closeNote)card.append(el('p','Closure: '+row.closeNote));
    if(row.evidence.length){
      const list=el('ul');
      for(const e of row.evidence)list.append(el('li',e.reference+' · '+capitalize(e.kind)+' · '+e.note));
      card.append(add(el('details'),el('summary','Evidence references ('+row.evidence.length+')'),list));
    }
    function action(name,...fields){
      const panel=add(el('details'),el('summary',incAction[name]));
      incidentForm(panel,incidentsPath+'/'+encodeURIComponent(row.id)+'/'+name,fields,incAction[name],row.revision);
      card.append(panel);
    }
    const select=(label,name,options)=>rightsSelect(label,name,[{value:'',label:'Select an option'},...options.map(value=>({value,label:capitalize(value)}))]);
    if(actor===row.owner){
      if(['logged','investigating'].includes(row.stage)){
        action('triage',select('Severity','severity',severities),rightsNote('Fictional triage rationale'));
      }
      if(row.stage==='investigating'){
        card.append(el('p',row.branch==='elevated'?
          'Record containment, findings and two evidence references, including one impact reference.':
          'Record containment, findings and one evidence reference.','hint'));
        action('containment',rightsNote('Fictional containment'));
        action('findings',rightsNote('Fictional findings'));
        action('evidence',labelled('Fictional reference such as SYN-CASE01','reference','','input'),select('Evidence type','kind',['general','impact']),rightsNote('Fictional evidence note'));
        if(row.readyForReview)action('request-review');
      }
      if(row.stage==='notice-planning')action('plan-notice',labelled('Fictional plan ID such as SYN-PLAN01','reference','','input'),rightsNote('Mock plan summary'));
      if(row.stage==='ready-to-close')action('close',rightsNote('Fictional closure rationale'));
    }
    if(actor==='reviewer'&&row.stage==='review')action('decide',select('Simulated notice decision','decision',decisions),rightsNote('Fictional reviewer rationale'));
    const history=el('ol',undefined,'log');
    for(const e of row.history.slice().reverse())history.append(el('li',e.action.replace('incident.case.','')+' · '+e.actor+' · '+e.at+
      (e.details.note?' · '+e.details.note:e.details.code?' · '+e.details.code:'')));
    card.append(add(el('details'),el('summary','Incident history ('+row.history.length+')'),history));
    listing.append(card);
  }
  const parts=[intro,listing];
  if(legacyRecords.length){
    const section=add(el('section'),heading('Legacy incident register entries'),el('p','These rows do not establish an independently reviewed decision.'));
    for(const e of legacyRecords)section.append(el('p',e.title+' · '+e.status));
    parts.push(section);
  }
  incidentPane.replaceChildren(...parts);
  focusWorkRecord('incidents');
}
$('#show-incidents').onclick=()=>switchView('incidents');
$('#actor').addEventListener('change',()=>{if(!incidentPane.hidden&&incidentData)renderIncidents()});
