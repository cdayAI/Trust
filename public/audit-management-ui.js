'use strict';
const auditMgmtPane=$('#audit-management-view'), auditMgmtPath='/api/audit-management';
let auditMgmtData, auditMgmtRequest=0;
async function refreshAuditManagement(){
  const tag=++auditMgmtRequest;
  try{
    const next=await read(auditMgmtPath);
    if(!auditMgmtPane.hidden&&tag===auditMgmtRequest){auditMgmtData=next;renderAuditManagement()}
  }catch(e){if(!auditMgmtPane.hidden&&tag===auditMgmtRequest){auditMgmtPane.replaceChildren(el('p','Audit plans could not be loaded.'));notice(e.message,true)}}
}
function auditMgmtForm(target,path,fields,caption,fn,revision){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();
    if(busy)return;
    busy=true;
    const tag=++auditMgmtRequest;
    const action=form.querySelector('button');action.disabled=true;
    try{
      const data=new FormData(form);
      const payload=fn?fn(data):Object.fromEntries(data);
      if(revision!==undefined)payload.expectedRevision=revision;
      const next=await read(auditMgmtPath+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(payload)});
      if(!auditMgmtPane.hidden&&tag===auditMgmtRequest){auditMgmtData=next;renderAuditManagement();notice('Audit plan updated.')}
    }catch(e){
      if(!auditMgmtPane.hidden&&tag===auditMgmtRequest){
        notice(e.message,true);
        if(e.status===409){const reload=button('Reload audit plans','button','secondary');reload.onclick=refreshAuditManagement;$('#notice').append(document.createTextNode(' '),reload)}
      }
    }finally{busy=false;action.disabled=false}
  };
  target.append(form);
  return form;
}
function auditMgmtSelect(label,name,values){
  const select=el('select');select.name=name;select.required=true;
  const blank=el('option','Select…');blank.value='';select.append(blank);
  for(const value of values){const option=el('option',value);option.value=value;select.append(option)}
  return add(el('label',label),select);
}
function renderAuditManagement(){
  const {plans,controls,outcomes,severities}=auditMgmtData;
  const analyst=actor==='analyst', reviewer=actor==='reviewer';
  const intro=add(el('section'),heading('Audit management'),
    el('p','Plan a scoped audit, assess local synthetic evidence against registered controls, and send the results to a separate reviewer. Do not use real evidence or records.'));
  if(analyst&&controls.length){
    const selection=add(el('fieldset'),el('legend','Controls in scope'));
    for(const c of controls){
      const input=el('input');input.type='checkbox';input.name='controlIds';input.value=c.id;
      selection.append(add(el('label'),input,document.createTextNode(' '+c.title)));
    }
    auditMgmtForm(intro,'/plans',[
      labelled('Synthetic audit title','title','','input'),labelled('Audit objective','objective',''),
      labelled('Scope and review period','scope',''),selection
    ],'Create audit plan',data=>({...Object.fromEntries(data),controlIds:data.getAll('controlIds')}));
  } else if(analyst)intro.append(el('p','Add a control in Risk and controls before creating an audit plan.','hint'));
  const list=add(el('section'),heading('Audit plans'));
  if(!plans.length)list.append(el('p','No audit plans yet.'));
  for(const plan of plans.slice().reverse()){
    const path='/plans/'+plan.id;
    const card=add(el('article',undefined,'module-record'),el('h3',plan.title),badge(plan.status),el('p',plan.objective),el('p','Scope: '+plan.scope),
      el('p','Plan revision '+plan.revision+' · Created by '+plan.createdBy,'hint'));
    const scoped=add(el('ul'));
    for(const c of plan.controls){
      const assessed=plan.assessments.filter(a=>a.controlId===c.id);
      const current=assessed.at(-1);
      const item=add(el('li'),el('h4',c.title),el('p',c.intent,'hint'));
      if(current){
        item.append(el('p',current.outcome+' · '+current.evidenceReference),el('p',current.observation));
        if(current.finding)item.append(el('p','Finding · '+current.finding.severity+' · Proposed action: '+current.finding.correctiveAction));
        if(assessed.length>1){
          const versions=add(el('details'),el('summary','Prior evidence versions'));
          for(const old of assessed.slice(0,-1).reverse())versions.append(el('p',old.evidenceReference+' · '+old.outcome+' · '+old.observation,'hint'));
          item.append(versions);
        }
      }else item.append(el('p','Not yet assessed.','hint'));
      if(analyst&&plan.status==='fieldwork'){
        const outcome=auditMgmtSelect('Assessment outcome','outcome',outcomes);
        const severity=auditMgmtSelect('Finding severity','severity',severities);
        const corrective=labelled('Proposed corrective action','correctiveAction','');
        const finding=add(el('div'),severity,corrective);
        const sync=()=>{
          const shows=outcome.querySelector('select').value==='exception';
          finding.hidden=!shows;
          for(const input of finding.querySelectorAll('select,textarea'))input.disabled=!shows;
        };
        outcome.onchange=sync;sync();
        const panel=add(el('details'),el('summary',current?'Record revised evidence':'Assess control'));
        auditMgmtForm(panel,path+'/assess',[labelled('Synthetic evidence reference','evidenceReference','','input'),
          outcome,labelled('Synthetic evidence observation','observation',''),finding],
          'Record evidence',data=>({...Object.fromEntries(data),controlId:c.id}),plan.revision);
        item.append(panel);
      }
      scoped.append(item);
    }
    card.append(scoped);
    for(const r of plan.reviews)card.append(el('p',r.decision+' by '+r.reviewer+': '+r.note,'hint'));
    if(analyst&&plan.status==='planned')auditMgmtForm(card,path+'/begin',[],'Begin fieldwork',null,plan.revision);
    if(analyst&&plan.status==='fieldwork'){
      if(plan.controls.every(c=>plan.assessments.some(a=>a.controlId===c.id)))auditMgmtForm(card,path+'/submit',[],'Submit audit for review',null,plan.revision);
      else card.append(el('p','Assess each scoped control before submitting.','hint'));
    }
    if(reviewer&&plan.status==='in-review'){
      const finalize=add(el('details'),el('summary','Finalize audit'));
      auditMgmtForm(finalize,path+'/finalize',[labelled('Final review rationale','note','')],'Finalize and freeze report',null,plan.revision);
      const returnPanel=add(el('details'),el('summary','Return audit for changes'));
      auditMgmtForm(returnPanel,path+'/return',[labelled('Reason for return','note','')],'Return to fieldwork',null,plan.revision);
      card.append(finalize,returnPanel);
    }
    if(plan.final){
      const {result,sha256}=plan.final;
      const link=el('a','Download finalized report JSON','button quiet');
      link.href=scopeUrl(auditMgmtPath+path+'/report');link.download='';
      card.append(el('p','Conclusion: '+result.conclusion),el('p','Report SHA-256: '+sha256,'hint'),link);
    }
    list.append(card);
  }
  auditMgmtPane.replaceChildren(intro,list);
}
$('#show-audit-management').onclick=()=>switchView('audit-management');
$('#actor').addEventListener('change',()=>queueMicrotask(()=>{if(!auditMgmtPane.hidden)refreshAuditManagement()}));
