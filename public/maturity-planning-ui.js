'use strict';
const maturityPane=$('#maturity-planning-view'),maturityPath='/api/maturity-planning';
let maturityData,maturitySequence=0;

async function refreshMaturityPlanning(){
  const seq=++maturitySequence;
  try{
    const next=await read(maturityPath);
    if(!maturityPane.hidden&&seq===maturitySequence){maturityData=next;renderMaturityPlanning()}
  }catch(error){if(!maturityPane.hidden&&seq===maturitySequence){maturityPane.replaceChildren(el('p','Maturity plans could not be loaded.'));notice(error.message,true)}}
}
function maturityForm(parent,path,fields,caption,map,revision){
  const submit=button(caption,'submit'),form=add(el('form'),...fields,submit);
  parent.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;submit.disabled=true;
    const seq=++maturitySequence;
    try{
      const fields=new FormData(form),payload=map?map(fields):Object.fromEntries(fields);
      if(revision!==undefined)payload.expectedRevision=revision;
      const model=await read(maturityPath+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(payload)});
      if(!maturityPane.hidden&&seq===maturitySequence){maturityData=model;renderMaturityPlanning();notice('Maturity plan updated.')}
    }catch(error){
      if(!maturityPane.hidden&&seq===maturitySequence){
        notice(error.message,true);
        if(error.status===409){const reload=button('Reload maturity plans','button','secondary');reload.onclick=refreshMaturityPlanning;$('#notice').append(document.createTextNode(' '),reload)}
      }
    }finally{submit.disabled=false;busy=false}
  };
  return submit;
}
function maturityDate(text,name,value='',max){
  const label=labelled(text,name,value,'input'),input=label.querySelector('input');
  input.type='date';if(max)input.max=max;
  return label;
}
function maturitySelect(text,name,options,selected){
  const select=el('select');select.name=name;select.required=true;select.setAttribute('aria-label',text);
  for(const [key,label] of options){const option=el('option',label);option.value=key;select.append(option)}
  if(selected!==undefined)select.value=String(selected);
  return add(el('label',text),select);
}
function maturityScoreForm(parent,path,version,entry,revision){
  const current=entry.assessment,levels=version.rubric.levels.map((label,index)=>[index,index+' · '+label]);
  const base=maturitySelect('Baseline maturity level','baseline',levels,current?.baseline??0);
  const target=maturitySelect('Target maturity level','target',levels,current?.target??1);
  const source=maturitySelect('Evidence source type','evidenceType',Object.entries(maturityData.sources)
    .filter(([type])=>type==='synthetic'||maturityData.evidenceOptions.some(row=>row.type===type)), current?.evidence.type??'synthetic');
  const reference=labelled('Synthetic evidence reference','evidenceReference',current?.evidence.type==='synthetic'?current.evidence.reference:'','input');
  const linked=maturitySelect('Eligible linked evidence','linkedEvidence',[['','Choose evidence']]);
  const gap=add(el('div'),labelled('Roadmap action','action',current?.action??''),
    maturityDate('Roadmap action due date (UTC)','dueDate',current?.dueDate??'',version.targetDate));
  const board=add(el('details'),el('summary',current?'Revise capability assessment':'Score capability'));
  maturityForm(board,path+'/assess',[
    add(el('div',undefined,'maturity-form-grid'),base,target,source,reference,linked),
    labelled('Fictional scoring rationale','rationale',current?.rationale??''),gap
  ],'Save capability score',fields=>{
    const values=Object.fromEntries(fields),{linkedEvidence,...rest}=values;
    if(values.evidenceType!=='synthetic')rest.evidenceReference=linkedEvidence;
    return {...rest,capability:entry.id,baseline:Number(rest.baseline),target:Number(rest.target)};
  },revision);
  const referenceField=reference.querySelector('input'),linkedField=linked.querySelector('select'),sourceField=source.querySelector('select');
  function syncEvidence(){
    const synthetic=sourceField.value==='synthetic';
    reference.hidden=!synthetic;referenceField.disabled=!synthetic;
    linked.hidden=synthetic;linkedField.disabled=synthetic;
    const placeholder=el('option','Choose evidence');placeholder.value='';linkedField.replaceChildren(placeholder);
    if(!synthetic)for(const row of maturityData.evidenceOptions.filter(x=>x.type===sourceField.value)){
      const option=el('option',row.label);option.value=row.id;linkedField.append(option);
    }
    if(!synthetic&&current?.evidence.type===sourceField.value)linkedField.value=current.evidence.reference;
  }
  const baseField=base.querySelector('select'),targetField=target.querySelector('select');
  function syncGap(){
    const enabled=Number(targetField.value)>Number(baseField.value);
    gap.hidden=!enabled;
    for(const field of gap.querySelectorAll('textarea,input'))field.disabled=!enabled;
  }
  sourceField.onchange=syncEvidence;baseField.onchange=syncGap;targetField.onchange=syncGap;
  syncEvidence();syncGap();parent.append(board);
}
function maturityRoadmap(edition){
  const block=add(el('div'),el('h4','Prioritized roadmap'));
  if(!edition.roadmap.gaps.length){block.append(el('p','No improvement gaps in the scored capabilities.','hint'));return block}
  const list=el('ol',undefined,'maturity-roadmap');
  for(const item of edition.roadmap.gaps){
    list.append(add(el('li'),add(el('div',undefined,'row'),el('strong',item.label),badge(item.priority+' priority')),
      el('p',item.action),el('p',item.owner+' · Due '+item.dueDate+' UTC · Gap '+item.gap+' · Priority score '+item.priorityScore,'hint')));
  }
  block.append(list);return block;
}
function renderMaturityPlanning(){
  const {plans,capabilities,rubric}=maturityData,analyst=actor==='analyst',reviewer=actor==='reviewer';
  const intro=add(el('section'),el('p','PROGRAM ASSURANCE','eyebrow'),heading('Maturity planning'),
    el('p','Score a scoped synthetic baseline and target, review supporting evidence, and prioritize work for the next version.'));
  const rubricPanel=add(el('details'),el('summary','Scoring rubric'));
  const levelList=el('ul');
  for(const [index,description] of rubric.levels.entries())levelList.append(el('li',index+' · '+description));
  rubricPanel.append(levelList,el('p','Priority score = level gap × capability weight. Current and target maturity are weighted averages over all scoped capabilities.','hint'));
  intro.append(rubricPanel);
  if(analyst){
    const create=add(el('details'),el('summary','New maturity plan'));
    const scope=add(el('fieldset'),el('legend','Capabilities in scope'));
    for(const item of capabilities){
      const box=el('input');box.type='checkbox';box.name='capabilityIds';box.value=item.id;
      scope.append(add(el('label'),box,document.createTextNode(' '+item.label+' · Weight '+item.weight)));
    }
    maturityForm(create,'/plans',[
      labelled('Maturity plan title','title','','input'),labelled('Fictional planning scope','scope',''),
      maturityDate('Version target date (UTC)','targetDate'),scope
    ],'Create maturity plan',fields=>({...Object.fromEntries(fields),capabilityIds:fields.getAll('capabilityIds')}));
    intro.append(create);
  }
  const list=add(el('section'),heading('Program plans'));
  if(!plans.length)list.append(el('p','No maturity plans yet.'));
  for(const plan of plans.slice().reverse()){
    const version=plan.versions.at(-1),route='/plans/'+plan.id,stats=version.roadmap,revisions=plan.versions.length;
    const card=add(el('article',undefined,'module-record'),
      add(el('div',undefined,'row'),el('h3',plan.title),badge(version.status.replace('-',' '))),
      el('p',plan.scope),el('p','Version '+version.number+' · Target '+version.targetDate+' UTC · Plan revision '+plan.revision,'hint'));
    const metrics=el('div',undefined,'metrics');
    const values=[
      [version.status==='approved'?'Signed baseline':'Proposed baseline',stats.baseline===null?'Pending':stats.baseline+' / 4'],
      ['Target maturity',stats.target===null?'Pending':stats.target+' / 4'],
      ['Accepted evidence',stats.accepted+' / '+stats.inScope]
    ];
    for(const [caption,value] of values)metrics.append(add(el('div',undefined,'metric'),el('strong',value),el('span',caption)));
    card.append(metrics,el('h4','Capability assessments'));
    for(const entry of stats.rows){
      const detail=add(el('div',undefined,'maturity-capability'),el('h5',entry.label),el('p',entry.guide,'hint'));
      const row=entry.assessment,decision=entry.evidenceDecision;
      if(row){
        detail.append(el('p','Baseline '+row.baseline+' → Target '+row.target+' · Weight '+entry.weight),
          el('p',maturityData.sources[row.evidence.type]+': '+row.evidence.reference),el('p',row.rationale));
        detail.append(el('p',decision?'Evidence '+(decision.decision==='accept'?'accepted':'rejected')+': '+decision.note:'Evidence awaiting review.','hint'));
      }else detail.append(el('p','Not yet scored.','hint'));
      if(analyst&&version.status==='draft')maturityScoreForm(detail,route,version,entry,plan.revision);
      if(reviewer&&version.status==='in-review'&&row&&!decision){
        const review=add(el('details'),el('summary','Review capability evidence'));
        maturityForm(review,route+'/decide',[
          maturitySelect('Evidence decision','decision',[['','Choose…'],['accept','Accept'],['reject','Reject']]),
          labelled('Evidence decision rationale','note','')
        ],'Record evidence decision',fields=>({...Object.fromEntries(fields),capability:entry.id,scoreId:row.id}),plan.revision);
        detail.append(review);
      }
      card.append(detail);
    }
    card.append(maturityRoadmap(version));
    if(analyst&&version.status==='draft'){
      const send=maturityForm(card,route+'/submit',[],'Submit maturity plan',null,plan.revision);
      send.disabled=stats.assessed!==stats.inScope;
      if(send.disabled)card.append(el('p','Score every scoped capability to submit this version.','hint'));
    }
    if(reviewer&&version.status==='in-review'){
      const returnBlock=add(el('details'),el('summary','Return version for changes'));
      maturityForm(returnBlock,route+'/return',[labelled('Return rationale','note','')],'Return plan',null,plan.revision);
      card.append(returnBlock);
      const ready=stats.accepted===stats.inScope;
      if(ready)maturityForm(card,route+'/approve',[labelled('Independent signoff rationale','note','')],'Sign version',null,plan.revision);
      else card.append(el('p','Accept all current capability evidence before signoff. Return rejected or incomplete evidence to the analyst.','hint'));
    }
    if(analyst&&version.status==='approved'){
      const next=add(el('details'),el('summary','Open next version'));
      maturityForm(next,route+'/revise',[maturityDate('Next version target date (UTC)','targetDate',version.targetDate)],'Create next version',null,plan.revision);
      card.append(next);
    }
    if(version.reviews.length){
      const reviewHistory=add(el('details'),el('summary','Version decision history'));
      for(const review of version.reviews.slice().reverse())reviewHistory.append(el('p',review.decision+' · '+review.reviewer+' · '+review.note));
      card.append(reviewHistory);
    }
    const signed=plan.versions.filter(v=>v.final);
    if(signed.length){
      const history=add(el('div'),el('h4',revisions===1?'Signed plan':'Signed version history'));
      for(const approved of signed.slice().reverse()){
        const download=el('a','Download signed version '+approved.number,'button quiet');
        download.href=scopeUrl(maturityPath+route+'/versions/'+approved.number+'/report');download.download='';
        history.append(add(el('p',undefined,'maturity-download'),download,document.createTextNode(' Baseline '+approved.roadmap.baseline+' → '+approved.roadmap.target),
          el('small',' SHA-256 '+approved.final.sha256,'hint')));
      }
      card.append(history);
    }
    list.append(card);
  }
  maturityPane.replaceChildren(intro,list);
}
$('#actor').addEventListener('change',()=>queueMicrotask(()=>{if(!maturityPane.hidden&&maturityData)renderMaturityPlanning()}));
$('#show-maturity-planning').onclick=()=>switchView('maturity-planning');
