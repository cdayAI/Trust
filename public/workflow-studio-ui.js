'use strict';
const studioPane=$('#workflow-studio-view'),studioPath='/api/workflows';
let studio,studioDemoActor='analyst',studioSelected='',studioGeneration=0;
const studioHeaders=()=>({'Content-Type':'application/json','X-Demo-Actor':studioDemoActor});
const studioPost=(path,body)=>read(studioPath+path,{method:'POST',headers:studioHeaders(),body:JSON.stringify(body)});
const studioGet=path=>read(studioPath+path,{headers:studioHeaders()});
async function refreshStudio(){
  const generation=++studioGeneration;
  try{
    const model=await studioGet('/studio'+(studioSelected?'/'+encodeURIComponent(studioSelected):''));
    if(generation===studioGeneration&&!studioPane.hidden){studio=model;renderStudio()}
  }catch(error){if(generation===studioGeneration&&!studioPane.hidden)studioPane.replaceChildren(el('p',error.message,'error'))}
}
function studioButton(label,onClick){
  const b=button(label,'button','secondary');b.onclick=onClick;return b;
}
function studioSelect(label,name,choices){
  const s=el('select');s.name=name;s.required=true;
  for(const [value,label] of choices){const opt=el('option',label);opt.value=value;s.append(opt)}
  return add(el('label',label),s);
}
function renderStudio(){
  const intro=add(el('section'),heading('Workflow studio'),el('p','Build and run fictional workflows. Published versions are immutable and this studio does not change the core assessment runtime.'));
  if(studio.mode==='synthetic-demo'){
    const demo=studioSelect('Workflow demo identity','studio-role',[['analyst','Initiator'],['reviewer','Reviewer'],['publisher','Publisher']]);
    const field=demo.querySelector('select');field.value=studioDemoActor;
    field.onchange=()=>{studioDemoActor=field.value;refreshStudio()};intro.append(demo);
  }else intro.append(el('p','Workspace role: '+studio.actor.role));
  const defs=add(el('section'),heading('Published definitions'));
  if(!studio.definitions.length)defs.append(el('p','No published workflows yet.'));
  const detail=el('div');
  const draftArea=el('div');
  const versionChoices=[];
  for(const definition of studio.definitions){
    const row=add(el('div',undefined,'module-record'),el('h3',definition.label));
    for(const version of definition.versions.slice().reverse()){
      versionChoices.push([definition.id+':'+version,definition.label+' · version '+version]);
      row.append(studioButton('View '+definition.id+' version '+version,async()=>{
        try{
          const opened=await studioGet('/definitions/'+encodeURIComponent(definition.id)+'/'+version);
          const listing=el('ul');
          for(const link of opened.transitions)listing.append(el('li',link.id+': '+link.from+' → '+link.to+' · '+link.roles.join(', ')+
            (link.independent?' · independent':'')+(link.requiredFields.length?' · required: '+link.requiredFields.join(', '):'')));
          const states=el('ul');
          for(const step of opened.states)states.append(el('li',step.id+' · '+step.label));
          detail.replaceChildren(el('h3',opened.label??opened.id),el('p','Version '+opened.version+' · initial state '+opened.initial),el('h4','States'),states,el('h4','Transitions'),listing);
          if(studio.actor?.role==='publisher'&&version===definition.versions.at(-1))
            detail.append(studioButton('Use as next draft',()=>buildStudioDraft(draftArea,opened,version)));
        }catch(error){notice(error.message,true)}
      }));
    }
    defs.append(row);
  }
  defs.append(detail);
  const draft=add(el('section'),heading('Prepare a definition'));
  if(studio.actor?.role==='publisher'){
    for(const recipe of studio.recipes)draft.append(studioButton('Load '+recipe.label,()=>buildStudioDraft(draftArea,recipe,0)));
    draft.append(draftArea);
  }else draft.append(el('p','Only a publisher can edit and publish definitions.'));
  const run=add(el('section'),heading('Synthetic instances'));
  if(studio.actor?.role==='initiator'&&versionChoices.length){
    const form=add(el('form'),studioSelect('Published workflow version','definition',versionChoices),
      labelled('Fictional instance title','title','','input'),button('Start pinned instance','submit'));
    form.onsubmit=async e=>{
      e.preventDefault();if(busy)return;busy=true;
      try{
        const [definitionId,v]=form.elements.definition.value.split(':');
        const answer=await studioPost('/instances',{definitionId,version:Number(v),title:form.elements.title.value});
        studioSelected=answer.instance.id;await refreshStudio();notice('Pinned instance started.');
      }catch(error){notice(error.message,true)}
      finally{busy=false}
    };
    run.append(form);
  }
  if(studio.instances.length){
    const selector=studioSelect('Open synthetic instance','instance',[['','Choose an instance'],...studio.instances.map(x=>[x.id,x.title+' · '+x.state])]);
    const field=selector.querySelector('select');field.value=studioSelected;
    field.onchange=()=>{studioSelected=field.value;refreshStudio()};
    run.append(selector);
  }
  if(studio.selected){
    const {instance,actions,stateLabel}=studio.selected;
    run.append(el('h3',instance.title),el('p',stateLabel+' · '+instance.definitionId+' version '+instance.definitionVersion+' · revision '+instance.revision));
    if(!actions.length)run.append(el('p','No transitions from this state.'));
    for(const action of actions){
      const card=add(el('article',undefined,'module-record'),el('h4',action.id+' → '+action.to));
      if(!action.allowed)card.append(el('p',action.blockedReason));
      else{
        const form=add(el('form'),...action.requiredFields.map(key=>labelled(key,key,'','textarea')),button('Run '+action.id,'submit'));
        form.onsubmit=async e=>{
          e.preventDefault();if(busy)return;busy=true;
          try{
            await studioPost('/instances/'+encodeURIComponent(instance.id)+'/transitions',{
              transitionId:action.id,expectedRevision:instance.revision,fields:Object.fromEntries(new FormData(form))
            });
            await refreshStudio();notice('Workflow advanced.');
          }catch(error){notice(error.message,true);if(error.status===409)await refreshStudio()}
          finally{busy=false}
        };
        card.append(form);
      }
      run.append(card);
    }
  }
  const audit=add(el('section'),heading('Recent workflow audit'));
  if(!localSession||localSession.capabilities.workspaceAudit){
    const link=el('a','Export full workflow audit JSON','button quiet');link.href=scopeUrl(studioPath+'/audit');link.download='';audit.append(link);
  }
  const log=el('ol');
  for(const event of studio.recentAudit)log.append(el('li',event.kind+' · '+event.outcome+' · '+(event.actor?.id??'Unrecognized')+
    ' · '+(event.code??event.transitionId??event.definitionId??'')+' · '+event.at));
  audit.append(log);
  studioPane.replaceChildren(intro,defs,draft,run,audit);
}
function buildStudioDraft(pane,source,expectedVersion){
  const draft=structuredClone(source);
  const box=el('form');
  const title=labelled('Display name','displayName',draft.label??draft.id,'input');
  const id=labelled('Definition ID','definitionId',draft.id,'input');
  id.querySelector('input').readOnly=expectedVersion>0;
  const initial=labelled('Initial state ID','initial',draft.initial,'input');
  const stateBox=el('fieldset'),transitionBox=el('fieldset');
  stateBox.append(el('legend','States'));transitionBox.append(el('legend','Transitions'));
  function makeState(value){
    const row=add(el('div',undefined,'module-record'),labelled('State ID','key',value.id,'input'),
      labelled('State label','label',value.label,'input'));
    row.append(studioButton('Remove state',()=>row.remove()));
    stateBox.append(row);
  }
  function makeTransition(value){
    const row=add(el('div',undefined,'module-record'),labelled('Transition ID','key',value.id,'input'),
      labelled('From state ID','from',value.from,'input'),labelled('To state ID','to',value.to,'input'),
      labelled('Required field keys (comma-separated)','requiredKeys',value.requiredFields.join(', '),'input',false));
    const roles=el('fieldset');roles.append(el('legend','Permitted roles'));
    for(const role of localSession?['initiator','reviewer']:['publisher','initiator','reviewer']){
      const cb=el('input');cb.type='checkbox';cb.name='allowedRole';cb.value=role;cb.checked=value.roles.includes(role);
      roles.append(add(el('label',role),cb));
    }
    const independent=el('input');independent.type='checkbox';independent.name='independent';independent.checked=value.independent===true;
    row.append(roles,add(el('label','Require independent actor'),independent),studioButton('Remove transition',()=>row.remove()));
    transitionBox.append(row);
  }
  for(const value of draft.states)makeState(value);
  for(const value of draft.transitions)makeTransition(value);
  const statesButton=studioButton('Add state',()=>{if(stateBox.children.length<=50)makeState({id:'',label:''})});
  const transitionsButton=studioButton('Add transition',()=>{if(transitionBox.children.length<=100)makeTransition({id:'',from:'',to:'',roles:[],requiredFields:[]})});
  const confirmation=el('input');confirmation.type='checkbox';confirmation.required=true;
  box.append(el('p','Expected current published version: '+expectedVersion),id,title,initial,stateBox,statesButton,transitionBox,transitionsButton,
    add(el('label','Publish this exact immutable version'),confirmation),button('Publish workflow version','submit'));
  box.onsubmit=async event=>{
    event.preventDefault();if(!confirmation.checked||busy)return;busy=true;
    const value=(row,name)=>row.querySelector('input[name="'+name+'"]').value.trim();
    const definition={
      id:box.elements.definitionId.value.trim(),label:box.elements.displayName.value.trim(),initial:box.elements.initial.value.trim(),
      states:[...stateBox.querySelectorAll(':scope > div')].map(row=>({id:value(row,'key'),label:value(row,'label')})),
      transitions:[...transitionBox.querySelectorAll(':scope > div')].map(row=>({
        id:value(row,'key'),from:value(row,'from'),to:value(row,'to'),
        roles:[...row.querySelectorAll('input[name="allowedRole"]:checked')].map(x=>x.value),
        independent:row.querySelector('input[name="independent"]').checked,
        requiredFields:value(row,'requiredKeys').split(',').map(x=>x.trim()).filter(Boolean)
      }))
    };
    try{await studioPost('/definitions',{definition,expectedVersion});await refreshStudio();notice('Immutable workflow version published.')}
    catch(error){notice(error.message,true)}
    finally{busy=false}
  };
  pane.replaceChildren(box);
}
$('#show-workflow-studio').onclick=()=>switchView('workflow-studio');
