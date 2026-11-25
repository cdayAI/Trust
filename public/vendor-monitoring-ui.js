'use strict';
const vendorPane=$('#vendor-monitoring-view'),vendorPath='/api/vendor-monitoring';
let vendorData,vendorRequest=0,vendorAssessmentRequest=0;
async function refreshVendors(){
  const tag=++vendorRequest;
  try{const model=await read(vendorPath);if(!vendorPane.hidden&&tag===vendorRequest){vendorData=model;renderVendorMonitoring()}}
  catch(e){if(!vendorPane.hidden&&tag===vendorRequest){vendorPane.replaceChildren(el('p','Vendor monitoring could not be loaded.'));notice(e.message,true)}}
}
function vendorForm(parent,path,fields,caption,numbers=[],revision=vendorData.revision){
  const form=add(el('form'),...fields,button(caption,'submit'));
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    busy=true;const tag=++vendorRequest,submit=form.querySelector('button');submit.disabled=true;
    try{
      const body={...Object.fromEntries(new FormData(form)),expectedRevision:revision};
      for(const k of numbers)body[k]=Number(body[k]);
      const model=await read(vendorPath+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
      if(!vendorPane.hidden&&tag===vendorRequest){vendorData=model;renderVendorMonitoring();notice('Vendor monitoring updated.')}
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
  const tracked=new Set(cases.filter(c=>!c.engagement).map(c=>c.vendorId));
  const options=vendors.filter(v=>!tracked.has(v.id)).map(v=>({value:v.id,label:v.name+' · '+v.id.slice(0,8)}));
  const intro=add(el('section'),heading('Vendor monitoring and due diligence'),
    el('p','Track fictional vendors already in intake. No screening, contact, exchange or external monitoring occurs.'),
    el('p','Tier is criticality × exposure plus 2 each for declared AI and sensitive information. Policy v'+policy.version+' uses 365 / 180 / 90 / 30 UTC days by tier.','hint'));
  const factors=(a={})=>[riskNumber('Service criticality','criticality',a.criticality??3,1,5),riskNumber('Information exposure','exposure',a.exposure??3,1,5)];
  const ints=['criticality','exposure'];
  if(analyst&&options.length)vendorForm(intro,'/cases',[rightsSelect('Intake vendor','vendorId',options),...factors()],'Open monitoring case',ints);
  if(analyst&&vendors.length){
    const pane=add(el('details'),el('summary','Open named engagement'),
      el('p','Open parallel fictional services for the same vendor, with separate assessments, evidence and renewals.','hint'));
    vendorForm(pane,'/cases',[rightsSelect('Engagement vendor','vendorId',vendors.map(v=>({value:v.id,label:v.name+' · '+v.id.slice(0,8)}))),
      labelled('Engagement name','engagementTitle','','input'),labelled('Fictional engagement scope','engagementScope',''),...factors()],
      'Create named engagement',ints);
    intro.append(pane);
  }
  const listing=add(el('section'),heading('Monitoring cases'));
  if(!cases.length)listing.append(el('p','No vendor monitoring cases.'));
  for(const c of cases.slice().reverse()){
    const v=byVendor.get(c.vendorId), cycle=c.cycles.at(-1),path='/cases/'+c.id+'/';
    const identity=localSession?.account??actor,mayEdit=analyst&&(!c.engagement||c.ownerAccount===identity),
      mayReview=reviews&&(!c.engagement||c.ownerAccount!==identity);
    const form=(parent,step,fields,label,numbers=[])=>vendorForm(parent,path+step,fields,label,numbers,c.engagement?c.revision:vendorData.revision);
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',c.engagement?v.name+' · '+c.engagement.title:v.name),badge(c.status)),
      el('p','Cycle '+cycle.number+' · '+cycle.reason+' · '+cycle.factors.tier+' tier ('+cycle.factors.score+')'),
      el('p','Owner: '+(state?.actors.find(x=>x.id===c.owner)?.name??c.owner),'hint'),
      el('p',c.renewalDueDate?'Renewal: '+c.renewalDueDate+' UTC · '+c.renewalState:'Renewal date pending independent approval.','hint'));
    card.id='work-record-'+c.id;
    if(c.engagement)card.append(el('p',c.engagement.scope),el('p','Engagement '+c.id+' · Owner account '+c.ownerAccount+' · Revision '+c.revision,'hint'));
    const checks=el('ul');
    for(const a of c.assessmentStatus)checks.append(el('li',a.type+': '+a.status.replaceAll('_',' ')+' · '+a.id));
    card.append(checks);
    const project=button('Open linked assessments','button','secondary');
    project.onclick=async()=>{
      const tag=++vendorAssessmentRequest,identity=actor,session=localSession;
      const current=()=>tag===vendorAssessmentRequest&&identity===actor&&session===localSession&&
        !vendorPane.hidden&&!$('#workbench').hidden&&vendorPane.contains(project);
      try{
        const next=await read('/api/state');
        if(!current())return;
        state=next;selected=c.projectId;
        switchView('assessments',{engagementAssessments:c.engagement?{id:c.id,title:c.engagement.title,cycle:cycle.number,assessmentIds:cycle.assessmentIds}:null});
      }
      catch(e){if(current())notice(e.message,true)}
    };
    card.append(project);
    if(mayEdit&&c.status==='collecting'){
      form(riskPanel(card,'Update tier inputs'),'score',factors(cycle.factors),'Save tier inputs',ints);
      form(riskPanel(card,'Record due diligence evidence'),'evidence',[
        labelled('Fictional evidence reference such as SYN-VENDOR01','reference','','input'),rightsNote('Fictional evidence note')],'Record evidence');
      const hasApprovals=c.assessmentStatus.length>0&&c.assessmentStatus.every(a=>a.status==='approved');
      const hasEvidence=cycle.evidence.length>(cycle.review?.outcome==='returned'?cycle.review.evidenceCount:0);
      if(hasEvidence&&hasApprovals)form(card,'submit',[],'Submit for independent review');
      else card.append(el('p','Independent assessment approvals and current-cycle evidence are needed before submission.','hint'));
    }
    if(mayReview&&c.status==='review'){
      form(riskPanel(card,'Approve monitoring'),'approve',[rightsNote('Fictional review rationale')],'Approve monitoring');
      form(riskPanel(card,'Return for evidence'),'return',[rightsNote('Fictional review rationale')],'Return for evidence');
    }
    if(mayEdit&&c.status==='monitoring'){
      form(riskPanel(card,'Record a material change'),'change',[...factors(cycle.factors),rightsNote('Fictional material change rationale')],'Start change reassessment',ints);
      form(riskPanel(card,'Start a renewal'),'renew',[rightsNote('Fictional renewal rationale')],'Start renewal reassessment');
    }
    const history=add(el('details'),el('summary','Cycle and evidence history'));
    for(const past of c.cycles.slice().reverse()){
      const item=add(el('div'),el('h4','Cycle '+past.number+': '+past.reason),el('p','Tier '+past.factors.tier+' ('+past.factors.score+')'));
      if(past.note)item.append(el('p',past.note));
      for(const e of past.evidence)item.append(el('p',e.reference+': '+e.note));
      if(c.engagement)item.append(el('p','Cycle ID: '+past.assessmentCycleId,'hint'));
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
