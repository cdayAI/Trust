'use strict';
const vendorPane=$('#vendor-monitoring-view'),vendorPath='/api/vendor-monitoring';
let vendorData;
async function refreshVendors(){
  try{vendorData=await read(vendorPath);if(!vendorPane.hidden)renderVendorMonitoring()}
  catch(e){if(!vendorPane.hidden){vendorPane.replaceChildren(el('p','Vendor monitoring could not be loaded.'));notice(e.message,true)}}
}
function vendorForm(parent,path,fields,caption,numbers=[]){
  const revision=vendorData.revision;
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    busy=true;const submit=form.querySelector('button');submit.disabled=true;
    try{
      const body={...Object.fromEntries(new FormData(form)),expectedRevision:revision};
      for(const k of numbers)body[k]=Number(body[k]);
      vendorData=await read(vendorPath+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
      if(!vendorPane.hidden){renderVendorMonitoring();notice('Vendor monitoring updated.')}
    }catch(err){
      if(!vendorPane.hidden){
        notice(err.message,true);
        if(err.status===409&&err.message.includes('Reload')){
          const b=button('Reload vendor monitoring','button','secondary');
          b.onclick=async()=>{notice('');await refreshVendors()};
          $('#notice').append(document.createTextNode(' '),b);
        }
      }
    }finally{busy=false;submit.disabled=false}
  };
  parent.append(form);
}
function renderVendorMonitoring(){
  const {vendors,cases,legacyRecords,policy}=vendorData;
  const analyst=actor==='analyst',reviews=actor==='reviewer';
  const byVendor=new Map(vendors.map(v=>[v.id,v]));
  const tracked=new Set(cases.map(c=>c.vendorId));
  const options=vendors.filter(v=>!tracked.has(v.id)).map(v=>({value:v.id,label:v.name+' · '+v.id.slice(0,8)}));
  const intro=add(el('section'),heading('Vendor monitoring and due diligence'),
    el('p','Track fictional vendors already in intake. No screening, contact, exchange or external monitoring occurs.'),
    el('p','Tier is criticality × exposure plus 2 each for declared AI and sensitive information. Policy v'+policy.version+' uses 365 / 180 / 90 / 30 UTC days by tier.','hint'));
  const factors=(a={})=>[riskNumber('Service criticality','criticality',a.criticality??3,1,5),riskNumber('Information exposure','exposure',a.exposure??3,1,5)];
  const ints=['criticality','exposure'];
  if(analyst&&options.length)vendorForm(intro,'/cases',[rightsSelect('Intake vendor','vendorId',options),...factors()],'Open monitoring case',ints);
  const listing=add(el('section'),heading('Monitoring cases'));
  if(!cases.length)listing.append(el('p','No vendor monitoring cases.'));
  for(const c of cases.slice().reverse()){
    const v=byVendor.get(c.vendorId), cycle=c.cycles.at(-1),path='/cases/'+c.id+'/';
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',v.name),badge(c.status)),
      el('p','Cycle '+cycle.number+' · '+cycle.reason+' · '+cycle.factors.tier+' tier ('+cycle.factors.score+')'),
      el('p','Owner: '+(state?.actors.find(x=>x.id===c.owner)?.name??c.owner),'hint'),
      el('p',c.renewalDueDate?'Renewal: '+c.renewalDueDate+' UTC · '+c.renewalState:'Renewal date pending independent approval.','hint'));
    card.id='work-record-'+c.id;
    const checks=el('ul');
    for(const a of c.assessmentStatus)checks.append(el('li',a.type+': '+a.status.replaceAll('_',' ')+' · '+a.id));
    card.append(checks);
    const project=button('Open linked assessments','button','secondary');
    project.onclick=async()=>{
      try{state=await read('/api/state');selected=c.projectId;switchView('assessments')}
      catch(e){notice(e.message,true)}
    };
    card.append(project);
    if(analyst&&c.status==='collecting'){
      vendorForm(riskPanel(card,'Update tier inputs'),path+'score',factors(cycle.factors),'Save tier inputs',ints);
      vendorForm(riskPanel(card,'Record due diligence evidence'),path+'evidence',[
        labelled('Fictional evidence reference such as SYN-VENDOR01','reference','','input'),rightsNote('Fictional evidence note')],'Record evidence');
      const hasApprovals=c.assessmentStatus.length>0&&c.assessmentStatus.every(a=>a.status==='approved');
      const hasEvidence=cycle.evidence.length>(cycle.review?.outcome==='returned'?cycle.review.evidenceCount:0);
      if(hasEvidence&&hasApprovals)vendorForm(card,path+'submit',[],'Submit for independent review');
      else card.append(el('p','Independent assessment approvals and current-cycle evidence are needed before submission.','hint'));
    }
    if(reviews&&c.status==='review'){
      vendorForm(riskPanel(card,'Approve monitoring'),path+'approve',[rightsNote('Fictional review rationale')],'Approve monitoring');
      vendorForm(riskPanel(card,'Return for evidence'),path+'return',[rightsNote('Fictional review rationale')],'Return for evidence');
    }
    if(analyst&&c.status==='monitoring'){
      vendorForm(riskPanel(card,'Record a material change'),path+'change',[...factors(cycle.factors),rightsNote('Fictional material change rationale')],'Start change reassessment',ints);
      vendorForm(riskPanel(card,'Start a renewal'),path+'renew',[rightsNote('Fictional renewal rationale')],'Start renewal reassessment');
    }
    const history=add(el('details'),el('summary','Cycle and evidence history'));
    for(const past of c.cycles.slice().reverse()){
      const item=add(el('div'),el('h4','Cycle '+past.number+': '+past.reason),el('p','Tier '+past.factors.tier+' ('+past.factors.score+')'));
      if(past.note)item.append(el('p',past.note));
      for(const e of past.evidence)item.append(el('p',e.reference+': '+e.note));
      for(const a of past.assessmentSnapshot)item.append(el('p','Approved '+a.type+' assessment '+a.id+' · revision '+a.revision,'hint'));
      if(past.review)item.append(el('p',past.review.outcome+' by '+past.review.reviewedBy+': '+past.review.note));
      history.append(item);
    }
    card.append(history);listing.append(card);
  }
  const panes=[intro,listing];
  if(legacyRecords.length){
    const old=add(el('section'),heading('Historical vendor register'),el('p','Legacy entries are not monitoring decisions.'));
    for(const r of legacyRecords)old.append(el('p',r.title+' · '+r.status));
    panes.push(old);
  }
  vendorPane.replaceChildren(...panes);
  focusWorkRecord('vendor-monitoring');
}
$('#show-vendor-monitoring').onclick=()=>switchView('vendor-monitoring');
$('#actor').addEventListener('change',()=>{if(!vendorPane.hidden&&vendorData)renderVendorMonitoring()});
