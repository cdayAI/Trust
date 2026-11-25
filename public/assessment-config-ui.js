'use strict';
const assessmentConfigPane=$('#assessment-config-view'),assessmentConfigPath='/api/assessment-config';
const assessmentConfigLabels={pia:'PIA · Privacy impact assessment',dpia:'DPIA · Data protection impact assessment'};
let assessmentConfigModel,assessmentConfigSequence=0;
async function refreshAssessmentConfig(){
  const serial=++assessmentConfigSequence;
  try{
    const model=await read(assessmentConfigPath);
    if(!assessmentConfigPane.hidden&&serial===assessmentConfigSequence){assessmentConfigModel=model;renderAssessmentConfig()}
  }catch(error){if(!assessmentConfigPane.hidden&&serial===assessmentConfigSequence){assessmentConfigPane.replaceChildren(el('p','Assessment configuration could not be loaded.'));notice(error.message,true)}}
}
async function postAssessmentConfig(action,fields,control){
  if(busy)return;
  busy=true;control.disabled=true;
  const serial=++assessmentConfigSequence;
  try{
    const model=await read(assessmentConfigPath+'/'+action,{method:'POST',
      headers:{'Content-Type':'application/json','X-Demo-Actor':actor},
      body:JSON.stringify({expectedRevision:assessmentConfigModel.revision,...fields})});
    if(!assessmentConfigPane.hidden&&serial===assessmentConfigSequence){
      assessmentConfigModel=model;renderAssessmentConfig();
      notice({create:'Draft version created.',edit:'Draft saved. Routing preview updated.',submit:'Sent for independent review.',
        return:'Returned for changes.',publish:'Version published for future assessments.'}[action]);
    }
  }catch(error){
    if(!assessmentConfigPane.hidden&&serial===assessmentConfigSequence){
      notice(error.message,true);
      if(error.status===409){const reload=button('Reload configuration','button','secondary');reload.onclick=refreshAssessmentConfig;$('#notice').append(document.createTextNode(' '),reload)}
    }
  }finally{busy=false;control.disabled=false}
}
function assessmentConfigSelect(label,options,value){
  const field=el('select');field.setAttribute('aria-label',label);
  for(const [key,name] of options){const option=el('option',name);option.value=key;field.append(option)}
  field.value=value;
  return add(el('label',label),field);
}
function assessmentConfigText(label,value,max,required=true){
  const field=el('input');field.maxLength=max;field.required=required;field.value=value??'';
  return add(el('label',label),field);
}
function assessmentConfigDecision(action,label){
  const form=el('form'),note=labelled('Independent decision note','note',''),submit=button(label,'submit');
  note.querySelector('textarea').maxLength=500;
  form.append(note,submit);
  form.onsubmit=e=>{e.preventDefault();postAssessmentConfig(action,{note:new FormData(form).get('note')},submit)};
  return form;
}
function assessmentConfigOverview(release){
  const details=add(el('details'),el('summary','Questionnaires and routing preview'));
  for(const [type,form] of Object.entries(release.configuration.forms)){
    const questions=add(el('ul'),el('li','Summary · Text · Required'),el('li','Safeguards · Text · Required'));
    for(const question of form.questions)questions.append(el('li',question.label+' · '+question.kind+
      (question.required?' · Required':' · Optional')+(question.options?' · '+question.options.join(' / '):'')+
      (question.when?' · Only when '+question.when.question+' is '+question.when.equals:'')));
    details.append(el('h4',assessmentConfigLabels[type]+' — '+form.label),questions);
  }
  const rules=el('ol');
  for(const rule of release.configuration.rules){
    const condition=[Object.hasOwn(rule.match,'handlesSensitiveData')?'Sensitive information: '+(rule.match.handlesSensitiveData?'Yes':'No'):'',
      Object.hasOwn(rule.match,'usesAI')?'Uses AI: '+(rule.match.usesAI?'Yes':'No'):''].filter(Boolean).join(', ')||'Any remaining intake';
    rules.append(el('li',rule.id+' · '+condition+' → '+rule.form.toUpperCase()+'. '+rule.reason));
  }
  details.append(el('h4','Rules in priority order'),rules,el('h4','Routing preview (all four intake combinations)'));
  const preview=el('div',undefined,'assessment-config-grid');
  for(const item of release.preview)preview.append(add(el('div',undefined,'assessment-config-scenario'),
    el('strong','Sensitive: '+(item.handlesSensitiveData?'Yes':'No')+' · AI: '+(item.usesAI?'Yes':'No')),
    el('p',item.label+(item.rule?' · Rule '+item.rule:' · Built-in fallback'),'hint')));
  details.append(preview);return details;
}
function assessmentConfigEditor(release){
  const draft=structuredClone(release.configuration);
  const editor=add(el('details'),el('summary','Edit questionnaires and rules'));
  editor.open=true;
  const form=el('form'),editorRows=el('div'),save=button('Save configuration draft','submit'),
    title=assessmentConfigText('Release title',draft.title,120);
  editor.append(add(form,title,editorRows,save));
  const controls=[];
  const update=()=>{draft.title=title.querySelector('input').value;for(const sync of controls)sync()};
  function structure(change){
    update();change();renderRows();
  }
  function rowActions(items,index,label){
    const bar=el('div',undefined,'actions');
    const up=button('Move up','button','secondary'),down=button('Move down','button','secondary'),remove=button('Remove','button','secondary');
    up.setAttribute('aria-label','Move '+label+' up');down.setAttribute('aria-label','Move '+label+' down');remove.setAttribute('aria-label','Remove '+label);
    up.disabled=index===0;down.disabled=index===items.length-1;
    up.onclick=()=>structure(()=>[items[index-1],items[index]]=[items[index],items[index-1]]);
    down.onclick=()=>structure(()=>[items[index],items[index+1]]=[items[index+1],items[index]]);
    remove.onclick=()=>structure(()=>items.splice(index,1));bar.append(up,down,remove);return bar;
  }
  function questionEditor(items,question,index){
    const name='question '+(index+1);
    const item=add(el('fieldset',undefined,'assessment-config-item'),el('legend','Question '+(index+1)));
    const id=assessmentConfigText('Question key',question.id,40),label=assessmentConfigText('Question label',question.label,160),
      type=assessmentConfigSelect('Question type',[['text','Long text'],['choice','Single choice'],['integer','Whole number']],question.kind);
    id.querySelector('input').pattern=String.raw`[a-z][a-z0-9\x2d]{0,39}`;
    const required=el('input');required.type='checkbox';required.checked=question.required;
    const options=labelled('Choices (one per line)','choices',(question.options??[]).join('\n'),'textarea',false);
    const branch=assessmentConfigText('Earlier choice question key (optional)',question.when?.question,40,false),
      equals=assessmentConfigText('Show only for this exact choice',question.when?.equals,80,false);
    function sync(){
      const isChoice=type.querySelector('select').value==='choice';
      options.hidden=!isChoice;options.querySelector('textarea').disabled=!isChoice;
    }
    type.onchange=sync;sync();
    controls.push(()=>{
      question.id=id.querySelector('input').value;question.label=label.querySelector('input').value;
      question.kind=type.querySelector('select').value;question.required=required.checked;
      if(question.kind==='choice')question.options=options.querySelector('textarea').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
      else delete question.options;
      if(branch.querySelector('input').value||equals.querySelector('input').value)question.when={
        question:branch.querySelector('input').value,equals:equals.querySelector('input').value.trim()};
      else delete question.when;
    });
    item.append(add(el('div',undefined,'assessment-config-grid'),id,label,type,
      add(el('label',undefined,'assessment-config-check'),required,document.createTextNode('Required when visible'))),
      options,add(el('div',undefined,'assessment-config-grid'),branch,equals),rowActions(items,index,name));
    return item;
  }
  function ruleEditor(rule,index){
    const item=add(el('fieldset',undefined,'assessment-config-item'),el('legend','Rule '+(index+1)));
    const id=assessmentConfigText('Rule key',rule.id,40),
      target=assessmentConfigSelect('Questionnaire target',[['pia','PIA'],['dpia','DPIA']],rule.form),
      reason=assessmentConfigText('Routing explanation',rule.reason,240);
    id.querySelector('input').pattern=String.raw`[a-z][a-z0-9\x2d]{0,39}`;
    const conditions=['handlesSensitiveData','usesAI'].map((key,i)=>[key,assessmentConfigSelect(i?'Uses AI':'Handles sensitive information',
      [['any','Either'],['true','Yes'],['false','No']],Object.hasOwn(rule.match,key)?String(rule.match[key]):'any')]);
    controls.push(()=>{
      rule.id=id.querySelector('input').value;rule.form=target.querySelector('select').value;rule.reason=reason.querySelector('input').value;
      rule.match=Object.fromEntries(conditions.flatMap(([key,pick])=>{const val=pick.querySelector('select').value;
        return val==='any'?[]:[[key,val==='true']]}));
    });
    item.append(add(el('div',undefined,'assessment-config-grid'),id,target,...conditions.map(([,pick])=>pick)),
      reason,rowActions(draft.rules,index,'rule '+(index+1)));return item;
  }
  function renderRows(){
    controls.length=0;editorRows.replaceChildren();
    for(const [key,config] of Object.entries(draft.forms)){
      const pane=add(el('div',undefined,'assessment-config-builder'),el('h4',assessmentConfigLabels[key]));
      const label=assessmentConfigText('Questionnaire title',config.label,120),append=button('Add '+key.toUpperCase()+' question','button','secondary');
      controls.push(()=>{config.label=label.querySelector('input').value});
      append.disabled=config.questions.length>=16;
      append.onclick=()=>structure(()=>config.questions.push({id:'',label:'',kind:'text',required:false}));
      pane.append(label,el('p','Summary and Safeguards are always required. A conditional question must refer to an earlier choice question.','hint'),
        ...config.questions.map((q,i)=>questionEditor(config.questions,q,i)),append);
      editorRows.append(pane);
    }
    const rulePane=add(el('div',undefined,'assessment-config-builder'),el('h4','Ordered routing rules'),
      el('p','First match wins. Unmatched intake uses its built-in form. Sensitive intake cannot be sent to a PIA. AI reviews remain separate.','hint'));
    const append=button('Add routing rule','button','secondary');append.disabled=draft.rules.length>=4;
    append.onclick=()=>structure(()=>draft.rules.push({id:'',form:'dpia',match:{},reason:''}));
    rulePane.append(...draft.rules.map(ruleEditor),append);editorRows.append(rulePane);
  }
  renderRows();
  form.onsubmit=e=>{e.preventDefault();update();postAssessmentConfig('edit',{configuration:draft},save)};
  return editor;
}
function renderAssessmentConfig(){
  const {releases,activeVersion}=assessmentConfigModel,latest=releases.at(-1);
  const intro=add(el('section'),el('p','ASSESSMENT GOVERNANCE','eyebrow'),heading('Assessment configuration'),
    el('p','Configure synthetic PIA and DPIA questionnaires and decide which new intakes use them. Published versions never change existing assessments.'),
    el('p',activeVersion?'Active configuration: version '+activeVersion:'Active configuration: built-in privacy and AI questionnaires','hint'));
  if(actor==='analyst'&&(!latest||latest.status==='published')){
    const create=button(latest?'Draft next version':'Start configuration draft');create.onclick=()=>postAssessmentConfig('create',{},create);intro.append(create);
  }
  assessmentConfigPane.replaceChildren(intro);
  if(!latest)return;
  for(const release of releases.slice().reverse()){
    const current=release===latest;
    const card=add(el('section',undefined,'assessment-config-release'),add(el('div',undefined,'row'),
      el('h3','Version '+release.version+' · '+release.configuration.title),badge(release.status)));
    if(release.submittedAt)card.append(el('p','Submitted by '+release.submittedBy+' · '+release.submittedAt,'hint'));
    if(release.decisionNote)card.append(el('p','Reviewer '+release.decidedBy+': '+release.decisionNote,'hint'));
    card.append(assessmentConfigOverview(release));
    if(current&&actor==='analyst'&&['draft','returned'].includes(release.status)){
      const edit=assessmentConfigEditor(release),submit=button('Submit configuration for review','button','secondary');
      submit.onclick=()=>postAssessmentConfig('submit',{},submit);
      edit.querySelector('form').oninput=()=>{submit.disabled=true;submit.title='Save changes before submitting'};
      edit.addEventListener('click',event=>{if(event.target instanceof HTMLButtonElement&&event.target.type==='button'){submit.disabled=true;submit.title='Save changes before submitting'}});
      card.append(edit,submit);
    }
    if(current&&actor==='reviewer'&&release.status==='in_review'){
      const note=assessmentConfigDecision('publish','Approve and publish');
      const returned=button('Return configuration','submit','secondary');note.append(returned);
      note.onsubmit=e=>{e.preventDefault();postAssessmentConfig(e.submitter===returned?'return':'publish',{note:new FormData(note).get('note')},e.submitter??note.querySelector('button'))};
      card.append(note);
    }
    assessmentConfigPane.append(card);
  }
}

$('#show-assessment-config').onclick=()=>switchView('assessment-config');
$('#actor').addEventListener('change',()=>{if(!assessmentConfigPane.hidden&&assessmentConfigModel)renderAssessmentConfig()});
