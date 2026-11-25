'use strict';
const risksPane=$('#risk-controls-view'),risksPath='/api/risk-controls';
let riskData;
const riskReasons={'unlinked':'Unlinked','link-awaiting-review':'Mitigation link needs independent review','untested':'Not tested',
  'latest-test-failed':'Latest test failed','verified-pass':'Verified passing test','review-rejected':'Test evidence rejected','awaiting-independent-review':'Test evidence needs independent review'};
const riskScore=(label,x)=>label+': '+x.value+' ('+x.tier+') · likelihood '+x.likelihood+' × impact '+x.impact;
async function refreshRiskControls(){
  try{
    riskData=await read(risksPath);
    if(!risksPane.hidden)renderRiskControls();
  }catch(e){
    if(!risksPane.hidden){risksPane.replaceChildren(el('p','Risk and controls could not be loaded.'));notice(e.message,true)}
  }
}
function riskForm(parent,route,fields,label,numberFields=[]){
  const revision=riskData.revision;
  const form=add(el('form'),...fields,button(label,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    busy=true;const submit=form.querySelector('button');submit.disabled=true;
    try{
      const body={...Object.fromEntries(new FormData(form)),expectedRevision:revision};
      for(const f of numberFields)body[f]=Number(body[f]);
      riskData=await read(risksPath+route,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
      if(!risksPane.hidden){renderRiskControls();notice('Risk and controls updated.')}
    }catch(err){
      if(!risksPane.hidden){
        notice(err.message,true);
        if(err.status===409&&err.message.includes('Reload')){
          const b=button('Reload risk and controls','button','secondary');
          b.onclick=async()=>{notice('');await refreshRiskControls()};
          $('#notice').append(document.createTextNode(' '),b);
        }
      }
    }finally{busy=false;submit.disabled=false}
  };
  parent.append(form);
}
function riskNumber(label,name,value,min,max){
  const field=retentionField(label,name,String(value),'number');
  const input=field.querySelector('input');input.min=min;input.max=max;input.step=1;
  return field;
}
function riskId(name,value){
  const n=el('input');n.type='hidden';n.name=name;n.value=value;return n;
}
function riskPanel(parent,label){
  const panel=add(el('details'),el('summary',label));parent.append(panel);return panel;
}
function renderRiskControls(){
  const {risks,controls,tests,legacyRecords,rules,outcomes}=riskData;
  const analyst=actor==='analyst',reviewer=actor==='reviewer';
  const intro=add(el('section'),heading('Risk and controls'),el('p','Use fictional cases and evidence references only. No outside systems or tests are performed.'),
    el('p','Scoring rule v'+rules.version+': likelihood × impact. Residual risk uses the largest verified reduction per dimension, not the sum.','hint'));
  const exportLink=el('a','Export risk and controls JSON','button quiet');exportLink.href=scopeUrl(risksPath+'/export');exportLink.download='';intro.append(exportLink);
  const riskList=add(el('section'),heading('Risk register'));
  if(analyst){
    const panel=riskPanel(riskList,'Add risk');
    const detail=rightsNote('Fictional risk scenario');detail.querySelector('textarea').name='scenario';
    riskForm(panel,'/risks',[labelled('Fictional risk title','title','','input'),detail,riskNumber('Likelihood','likelihood',3,1,5),
      riskNumber('Impact','impact',3,1,5)],'Add risk',['likelihood','impact']);
  }
  const controlsById=new Map(controls.map(c=>[c.id,c]));
  if(!risks.length)riskList.append(el('p','No fictional risks.'));
  for(const risk of risks.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),el('h3',risk.title),el('p',risk.scenario),el('p',riskScore('Inherent score',risk.inherent)),
      el('p',riskScore('Residual score',risk.residual)),el('p','Applied reduction: '+risk.reduction.likelihood+' likelihood · '+risk.reduction.impact+' impact','hint'));
    card.id='work-record-'+risk.id;
    if(analyst){
      const rescore=riskPanel(card,'Re-score risk');
      riskForm(rescore,'/risks/'+risk.id+'/score',[riskNumber('Likelihood','likelihood',risk.likelihood,1,5),
        riskNumber('Impact','impact',risk.impact,1,5),rightsNote('Fictional re-score rationale')],'Save scores',['likelihood','impact']);
      const activeIds=new Set(risk.links.filter(l=>!l.archivedAt).map(l=>l.controlId));
      const options=controls.filter(c=>!activeIds.has(c.id)).map(c=>({value:c.id,label:c.title}));
      if(options.length){
        const linking=riskPanel(card,'Link mitigation');
        riskForm(linking,'/links',[riskId('riskId',risk.id),rightsSelect('Mitigating control','controlId',options),
          riskNumber('Likelihood reduction','likelihoodReduction',0,0,2),riskNumber('Impact reduction','impactReduction',0,0,2),
          rightsNote('Fictional mitigation rationale')],'Link mitigation',['likelihoodReduction','impactReduction']);
      }
    }
    for(const link of risk.links){
      const item=add(el('div'),el('p',controlsById.get(link.controlId).title+': '+riskReasons[link.reason]+' · '+link.note));
      if(link.reviewNote)item.append(el('p','Link review: '+link.reviewNote,'hint'));
      if(!link.archivedAt&&analyst)riskForm(riskPanel(item,'Unlink mitigation'),'/links/'+link.id+'/unlink',[rightsNote('Fictional unlink rationale')],'Unlink mitigation');
      if(!link.archivedAt&&!link.reviewedBy&&reviewer)riskForm(riskPanel(item,'Verify mitigation link'),'/links/'+link.id+'/verify',
        [rightsNote('Fictional mitigation review note')],'Verify mitigation link');
      card.append(item);
    }
    riskList.append(card);
  }
  const controlList=add(el('section'),heading('Control tests and evidence'));
  if(analyst){
    const panel=riskPanel(controlList,'Add control');
    const intent=rightsNote('Fictional control objective');intent.querySelector('textarea').name='intent';
    riskForm(panel,'/controls',[labelled('Fictional control title','title','','input'),intent],'Add control');
  }
  if(!controls.length)controlList.append(el('p','No fictional controls.'));
  const testsById=new Map(controls.map(c=>[c.id,[]]));
  for(const t of tests)testsById.get(t.controlId).push(t);
  for(const control of controls.slice().reverse()){
    const card=add(el('article',undefined,'module-record'),el('h3',control.title),el('p',control.intent));
    card.id='work-record-'+control.id;
    if(analyst){
      const panel=riskPanel(card,'Record test');
      riskForm(panel,'/tests',[riskId('controlId',control.id),rightsSelect('Test outcome','outcome',[
        {value:'',label:'Select an outcome'},...retentionOptions(outcomes)]),
        labelled('Fictional evidence ID such as SYN-CHECK01','evidenceReference','','input'),rightsNote('Fictional test note')],'Record test');
    }
    for(const t of testsById.get(control.id).slice().reverse()){
      const entry=add(el('div'),el('p',(t.id===control.latestTestId?'Current: ':'Superseded: ')+t.outcome+' · '+t.reviewStatus+' · '+t.evidenceReference+' · '+t.note));
      if(t.reviewNote)entry.append(el('p','Review: '+t.reviewNote,'hint'));
      if(reviewer&&t.id===control.latestTestId&&t.reviewStatus==='pending'){
        for(const [action,caption] of [['accept','Accept test evidence'],['reject','Reject test evidence']])
          riskForm(riskPanel(entry,caption),'/tests/'+t.id+'/'+action,[rightsNote('Fictional test review note')],caption);
      }
      card.append(entry);
    }
    controlList.append(card);
  }
  const panels=[intro,riskList,controlList];
  if(legacyRecords.length){
    const old=add(el('section'),heading('Legacy risk and control registers'),el('p','Historical generic entries are excluded from scores.'));
    for(const record of legacyRecords)old.append(el('p',record.title+' · '+record.status));
    panels.push(old);
  }
  risksPane.replaceChildren(...panels);
  focusWorkRecord('risk-controls');
}
$('#show-risk-controls').onclick=()=>switchView('risk-controls');
$('#actor').addEventListener('change',()=>{if(!risksPane.hidden&&riskData)renderRiskControls()});
