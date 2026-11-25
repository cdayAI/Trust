'use strict';

const rightsDeadlinePath='/api/rights/deadline-policy';
const rightsDeadlineReasons=[
  {value:'fixture-complexity',label:'Fictional complexity'},
  {value:'fixture-volume',label:'Fictional workload volume'},
  {value:'fixture-validation',label:'Fictional validation'}
];
const deadlineBasisLabel={calendar:'Calendar days (UTC)',business:'Business days (UTC)'};
function rightsDeadlineList(policy){
  return add(el('ul'),...policy.kinds.map(kind=>{
    const rule=policy.rules[kind];
    return el('li',kindLabel(kind)+': '+rule.days+' '+deadlineBasisLabel[rule.basis]+
      (rule.extensionDays?' · '+rule.extensionDays+' additional days if approved':' · No extension'));
  }));
}
function rightsDeadlinePanel(){
  const section=add(el('section'),heading('Fictional deadline policy'),
    el('p','Configure and review deadline rules for future cases. Published versions never recalculate existing cases.','hint'));
  const panel=add(el('details'),el('summary','View or configure deadline rules'));
  let generation=0;
  const content=el('div');panel.append(content);section.append(panel);
  async function load(){
    const requested=++generation;
    try{
      const model=await read(rightsDeadlinePath);
      if(requested===generation&&panel.isConnected&&panel.open)render(model);
    }catch(err){if(requested===generation&&panel.isConnected)content.replaceChildren(el('p',err.message,'error'));}
  }
  panel.ontoggle=()=>{if(panel.open)load()};
  function action(form,route,makeBody,resultCaption){
    form.onsubmit=async event=>{
      event.preventDefault();
      if(busy)return;
      busy=true;
      const control=form.querySelector('button');control.disabled=true;
      try{
        const model=await read(rightsDeadlinePath+'/'+route,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(makeBody(new FormData(form)))});
        if(!panel.isConnected)return;
        if(route==='publish'){
          await refreshRights();
          const next=rightsPane.querySelector('[data-rights-deadline-policy]');
          if(next){next.open=true;next.querySelector('summary').focus();}
        }else{
          render(model);
          panel.querySelector('summary').focus();
        }
        notice(resultCaption);
      }catch(error){
        if(!panel.isConnected)return;
        notice(error.message,true);
        if(error.status===409&&error.message.includes('Reload')){
          const reload=button('Reload deadline rules','button','secondary');
          reload.onclick=()=>{notice('');load();};
          $('#notice').append(document.createTextNode(' '),reload);
        }
      }
      finally{busy=false;control.disabled=false}
    };
  }
  function render(model){
    const active=model.versions.find(v=>v.version===model.activeVersion);
    const draft=model.draft;
    const versions=add(el('details'),el('summary','Published versions ('+model.versions.length+')'));
    for(const version of [...model.versions].reverse()){
      const memory=add(el('details'),el('summary','Published v'+version.version),
        rightsDeadlineList({...version,kinds:model.kinds}),
        el('p','Closed dates: '+(version.calendar.closedDates.join(', ')||'None'),'hint'));
      versions.append(memory);
    }
    content.replaceChildren(el('p','Active version: v'+active.version),rightsDeadlineList({...active,kinds:model.kinds}),
      el('p','Business days exclude Saturdays, Sundays, and fictional closed dates. The intake date is not counted.','hint'),versions);
    if(draft){
      content.append(el('p','Version '+draft.version+' is '+(draft.status==='review'?'awaiting independent publication':'a draft')+'.'));
      if(draft.status==='review'||actor==='reviewer'||!draft.ownDraft)
        content.append(rightsDeadlineList({...draft,kinds:model.kinds}),
          el('p','Draft closed dates: '+(draft.calendar.closedDates.join(', ')||'None'),'hint'));
    }
    const simple=(route,caption,message)=>{
      const form=add(el('form'),button(caption,'submit'));
      action(form,route,()=>({expectedRevision:model.revision}),message);
      content.append(form);
    };
    if(actor==='analyst'&&(!draft||draft.ownDraft&&draft.status==='draft')){
      const configuration=draft??active;
      const form=el('form');
      for(const kind of model.kinds){
        const rule=configuration.rules[kind];
        const group=add(el('fieldset'),el('legend',kindLabel(kind)),
          rightsSelect(kindLabel(kind)+' calendar','basis-'+kind,model.bases.map(value=>({value,label:deadlineBasisLabel[value]})),rule.basis));
        for(const [key,caption,min,max] of [['days','deadline days',1,365],['extensionDays','extension days',0,90]]){
          const field=labelled(kindLabel(kind)+' '+caption,key+'-'+kind,String(rule[key]),'input'),input=field.querySelector('input');
          Object.assign(input,{type:'number',min,max,required:true,step:1});group.append(field);
        }
        form.append(group);
      }
      const dates=labelled('Fictional closed dates (YYYY-MM-DD, separated by commas or new lines)','closedDates',
        configuration.calendar.closedDates.join(', '));
      dates.querySelector('textarea').maxLength=900;
      form.append(dates,button('Save deadline draft','submit'));
      action(form,'draft',values=>({expectedRevision:model.revision,
        closedDates:String(values.get('closedDates')).split(/[\s,]+/).filter(Boolean),
        rules:Object.fromEntries(model.kinds.map(kind=>[kind,{basis:values.get('basis-'+kind),days:Number(values.get('days-'+kind)),
          extensionDays:Number(values.get('extensionDays-'+kind))}]))}),'Deadline draft saved.');
      content.append(form);
      if(draft)simple('submit','Submit deadline policy for review','Deadline policy submitted for independent review.');
    }
    if(actor==='reviewer'&&draft?.status==='review'){
      simple('return','Return deadline policy','Deadline policy returned to its author.');
      simple('publish','Publish deadline policy','Deadline policy published for future cases.');
    }
  }
  panel.dataset.rightsDeadlinePolicy='';
  return section;
}
function renderRightsDeadlineCase(card,row){
  const pin=row.clockPolicy;
  if(pin.source!=='published')return;
  card.append(el('p','Pinned rules: v'+pin.version+' · '+pin.days+' '+pin.unit+' · Original due '+row.originalDueDate,'hint'));
  const requests=row.extensionRequests??[],pending=requests.find(x=>x.status==='pending');
  if(requests.length){
    const history=add(el('details'),el('summary','Extension requests ('+requests.length+')'),
      add(el('ul'),...requests.map(x=>el('li',rightsDeadlineReasons.find(reason=>reason.value===x.reason)?.label+
        ' · '+x.status+' · Proposed '+x.proposedDueDate))));
    card.append(history);
  }
  if(row.closedAt||!localSession?.authenticated)return;
  const base=rightsPath+'/'+encodeURIComponent(row.id);
  if(pending&&actor==='reviewer'){
    card.append(el('p','Extension requested: '+pending.proposedDueDate+' (UTC)'));
    if(!row.overdue)rightsForm(card,base+'/approve-extension',[],()=>({expectedRevision:row.revision}),'Approve deadline extension');
    rightsForm(card,base+'/reject-extension',[],()=>({expectedRevision:row.revision}),'Reject deadline extension');
  }
  if(actor===row.owner&&pin.extensionDays&&!row.overdue&&!pending&&!requests.some(x=>x.status==='approved')&&requests.length<3){
    const options=add(el('details'),el('summary','Request deadline extension'));
    rightsForm(options,base+'/request-extension',[rightsSelect('Fictional extension reason','reason',rightsDeadlineReasons)],
      values=>({...values,expectedRevision:row.revision}),'Submit extension request');
    card.append(options);
  }
}
