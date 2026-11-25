'use strict';
const incidentPane=$('#incident-view'),incidentsPath='/api/incidents/cases';
let incidentData,incidentSeq=0;
const incidentPolicyPath='/api/incidents/policy';
const incAction={
  triage:'Record severity',containment:'Record containment',evidence:'Add evidence reference',
  findings:'Record investigation findings','request-review':'Request notice review',decide:'Record simulated notice decision',
  'plan-notice':'Record mock notice plan',close:'Close incident'
};
const capitalize=s=>s[0].toUpperCase()+s.slice(1).replaceAll('-',' ');
async function refreshIncidents(focusId){
  const seq=++incidentSeq;
  try {
    const model=await read(incidentsPath);
    if(seq===incidentSeq&&!incidentPane.hidden){
      incidentData=model;renderIncidents();
      if(typeof focusId==='string'){
        const target=document.getElementById(focusId);
        const heading=target?.matches('article')?target.querySelector('h3'):target;
        if(heading&&incidentPane.contains(heading)){heading.tabIndex=-1;heading.focus()}
      }
    }
  }catch(error){
    if(seq===incidentSeq&&!incidentPane.hidden){incidentPane.replaceChildren(el('p','Incidents could not be loaded.'));notice(error.message,true)}
  }
}
function incidentForm(parent,path,fields,caption,revision,payload=raw=>raw){
  const save=button(caption,'submit'),form=add(el('form'),...fields,save);
  let conflict;
  form.onsubmit=async evt=>{
    evt.preventDefault();
    if(busy)return;
    busy=true;const seq=incidentSeq,identity=actor;save.disabled=true;
    conflict?.remove();
    try{
      const body=payload(Object.fromEntries(new FormData(form)));
      if(revision!==undefined)body.expectedRevision=revision;
      const model=await read(path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':identity},body:JSON.stringify(body)});
      if(seq===incidentSeq&&identity===actor&&!incidentPane.hidden){
        incidentData=model;renderIncidents();notice(path.startsWith(incidentPolicyPath)?'Incident policy updated.':'Incident updated.');
      }
    }catch(error){
      if(seq===incidentSeq&&identity===actor&&!incidentPane.hidden){
        if(error.status===409&&error.message.includes('Reload')){
          notice('');
          const alert=el('p',error.message,'error');
          alert.setAttribute('role','alert');alert.tabIndex=-1;
          const reload=button('Reload incidents','button','secondary');
          const focusId=parent.closest('article[id]')?.id??'incident-policy-heading';
          reload.onclick=()=>refreshIncidents(focusId);
          conflict=add(el('div'),alert,reload);form.append(conflict);
          alert.focus();
        }else notice(error.message,true);
      }
    }finally{busy=false;save.disabled=false}
  };
  parent.append(form);
}
function policyPanel(policy){
  const title=heading('Synthetic incident workflow policy');title.id='incident-policy-heading';
  const section=add(el('section'),title,
    el('p','Policy windows are internal simulation targets, not legal deadlines. Nothing sends a notice. Cases keep the policy version that was active when they opened.'));
  const last=policy.releases.at(-1);
  section.append(el('p',policy.activeVersion?'Active policy version '+policy.activeVersion:'Built-in routing is active. No configurable policy is published.'));
  if(actor==='analyst'&&(!last||last.status==='published'))incidentForm(section,incidentPolicyPath+'/create',[],'Draft incident policy',policy.revision);
  function reviewAction(card,action,caption){
    const panel=add(el('details'),el('summary',caption));
    incidentForm(panel,incidentPolicyPath+'/'+action,[rightsNote('Fictional policy review rationale')],caption,policy.revision);
    card.append(panel);
  }
  function duration(label,name,value,limit){
    const input=el('input');input.type='number';input.name=name;input.required=true;input.min='1';input.max=String(limit);input.step='1';input.value=String(value);
    return add(el('label',label),input);
  }
  for(const row of policy.releases.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),heading('Policy version '+row.version+' · '+capitalize(row.status)),
      el('p',row.definition.title));
    if(row.review)card.append(el('p','Review: '+row.review.note));
    if(row.hash)card.append(el('p','SHA-256 '+row.hash,'hint'));
    if(row.canEdit){
      const edit=add(el('details'),el('summary','Edit routing and windows'));
      const title=labelled('Fictional policy title','policy-title','','input');
      title.querySelector('input').value=row.definition.title;
      const fields=[title,...row.definition.routes.map((rule,index)=>add(el('fieldset'),
        el('legend',capitalize(rule.severity)+' / '+capitalize(rule.scopeClass)),
        (()=>{const field=rightsSelect('Investigation branch','branch-'+index,[{value:'standard',label:'Standard'},{value:'elevated',label:'Elevated'}]);
          const select=field.querySelector('select');select.value=rule.branch;if(['high','critical'].includes(rule.severity))select.querySelector('[value="standard"]').disabled=true;
          return field;})(),
        duration('Review window (hours)','review-'+index,rule.reviewHours,policy.bounds.reviewHours),
        duration('Mock notice window (hours)','notice-'+index,rule.noticeHours,policy.bounds.noticeHours)
      ))];
      incidentForm(edit,incidentPolicyPath+'/edit',fields,'Save incident routing',policy.revision,raw=>({
        definition:{title:raw['policy-title'],routes:row.definition.routes.map(({severity,scopeClass},index)=>({
          severity,scopeClass,branch:raw['branch-'+index],reviewHours:Number(raw['review-'+index]),noticeHours:Number(raw['notice-'+index])
        }))}
      }));
      card.append(edit);
      incidentForm(card,incidentPolicyPath+'/submit',[],'Submit incident policy',policy.revision);
    }else{
      const grid=el('ul');
      for(const route of row.definition.routes)grid.append(el('li',capitalize(route.severity)+' / '+capitalize(route.scopeClass)+' · '+
        capitalize(route.branch)+' · review '+route.reviewHours+' h · mock notice '+route.noticeHours+' h'));
      card.append(add(el('details'),el('summary','Routing and windows'),grid));
    }
    if(row.canReview){
      reviewAction(card,'return','Return incident policy');
      reviewAction(card,'publish','Publish incident policy locally');
    }
    section.append(card);
  }
  return section;
}
function renderIncidents(){
  const {cases,legacyRecords,severities,decisions,noticeName,policy}=incidentData;
  const intro=add(el('section'),heading('Privacy incidents'),el('p','Use fictional scope, findings and reference IDs. This workbench does not make legal determinations or send notices.'));
  if(actor==='analyst')incidentForm(intro,incidentsPath,[
    labelled('Fictional incident title','title','','input'),
    labelled('Fictional affected scope','scope',''),
    rightsSelect('Affected scope classification','scopeClass',[{value:'unknown',label:'Unknown'},...policy.scopeClasses.filter(key=>key!=='unknown').map(value=>({value,label:capitalize(value)}))])
  ],'Log incident');
  const listing=add(el('section'),heading('Incident queue'));
  if(!cases.length)listing.append(el('p','No fictional incidents.'));
  for(const row of cases.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',row.title),badge(capitalize(row.stage))),
      el('p','Incident ID: '+row.id,'hint'),el('p','Affected scope: '+row.scope));
    card.id='work-record-'+row.id;
    if(row.assessmentOrigin){
      const origin=row.assessmentOrigin;
      card.append(el('p','Linked to independently approved assessment revision '+origin.assessmentRevision+
        ' · Questionnaire v'+origin.questionnaireVersion+' · Workflow v'+origin.workflowDefinitionVersion,'hint'));
      if(localSession?.authenticated&&localSession.capabilities.views.includes('assessments')){
        const source=button('View approved source assessment','button','secondary');
        source.onclick=()=>openWorkTask({view:'assessments',recordId:origin.assessmentId,projectId:origin.projectId});
        card.append(source);
      }
    }
    card.append(el('p',row.policyPin?'Pinned policy version '+row.policyPin.version+' · '+capitalize(row.scopeClass)+' scope':'Built-in routing (no policy version)'));
    if(row.severity)card.append(el('p','Severity: '+capitalize(row.severity)+' · '+capitalize(row.branch)+' investigation'));
    if(row.windows){
      card.append(el('p','Configured windows: review '+row.windows.reviewHours+' h · mock notice '+row.windows.noticeHours+' h','hint'));
      for(const [label,due,status] of [['Review',row.windows.reviewDueAt,row.windows.reviewStatus],['Mock notice',row.windows.noticeDueAt,row.windows.noticeStatus]]){
        if(!due||!status)continue;
        const time=el('time',due.replace('T',' ').replace(/:[0-9.]+Z$/u,' UTC'));time.dateTime=due;
        card.append(add(el('p',label+' target · '),time,el('span',' · '+capitalize(status))));
      }
    }
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
        action('triage',select('Severity','severity',severities),
          rightsSelect('Triage scope classification','scopeClass',policy.scopeClasses.map(value=>({value,label:capitalize(value)})),row.scopeClass??'unknown'),
          rightsNote('Fictional triage rationale'));
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
  const parts=[intro,policyPanel(policy),listing];
  if(legacyRecords.length){
    const section=add(el('section'),heading('Legacy incident register entries'),el('p','These rows do not establish an independently reviewed decision.'));
    for(const e of legacyRecords)section.append(el('p',e.title+' · '+e.status));
    parts.push(section);
  }
  incidentPane.replaceChildren(...parts);
  focusWorkRecord('incidents');
}
$('#show-incidents').onclick=()=>switchView('incidents');
$('#actor').addEventListener('change',()=>{if(!incidentPane.hidden){incidentPane.replaceChildren(el('p','Loading incidents…'));refreshIncidents()}});
