'use strict';
let moduleData,moduleId,moduleActive=false,reportActive=false;
const mview=$('#module-view'), overview=$('#assessment-view');
const titleOf=(x)=>x.name??x.label??x.title??x.id;
const statusOf=(x)=>typeof x==='string'?x:x.id??x.value??x.name;
const fieldKey=(f)=>f.key??f.name??f.id;
function moduleField(f,value){
  if(f.type==='select'||f.type==='enum'||f.options){
    const s=el('select');s.name=fieldKey(f);s.required=!!f.required;
    s.append(el('option','Choose an option'));s.firstChild.value='';
    for(const opt of f.options??[]){const o=el('option',typeof opt==='string'?opt:titleOf(opt));o.value=typeof opt==='string'?opt:opt.value??opt.id;s.append(o)}
    s.value=value??'';return add(el('label',f.label??fieldKey(f)),s);
  }
  const kind=f.type==='textarea'?'textarea':'input';
  const l=labelled(f.label??fieldKey(f),fieldKey(f),value??'',kind,!!f.required), node=l.querySelector(kind);
  if(kind==='input'&&['date','number','email'].includes(f.type))node.type=f.type;
  if(f.type==='boolean'||f.type==='checkbox'){node.type='checkbox';node.required=false;node.checked=value===true}
  return l;
}
async function refreshModules(announce){
  try{
    moduleData=await read('/api/modules');
    if(moduleActive)renderModules();if(reportActive)renderReport();
    if(announce)notice(announce);
  }catch(error){if(moduleActive||reportActive){(reportActive?$('#report-view'):mview).replaceChildren(el('p','Could not load program records.'));notice(error.message,true)}}
}
async function saveModule(path,body,announce,form){
  if(busy)return;
  busy=true;
  try{
    for(const b of form.querySelectorAll('button'))b.disabled=true;
    await read(path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
    state=await read('/api/state');
    if(moduleActive)await refreshModules(announce);else render();
  }catch(error){notice(error.message,true)}
  finally{busy=false;for(const b of form.querySelectorAll('button'))b.disabled=false}
}
function renderModules(){
  const mods=moduleData?.modules??[];
  const m=mods.find(x=>x.id===moduleId)??mods[0];
  if(!m){mview.replaceChildren(el('p','No modules available.'));return}
  moduleId=m.id;
  const nav=el('nav');nav.setAttribute('aria-label','Program modules');
  for(const x of mods){
    const b=button(titleOf(x),'button','secondary');
    if(x.id===moduleId)b.setAttribute('aria-current','true');
    b.onclick=()=>{moduleId=x.id;notice('');renderModules()};
    nav.append(b);
  }
  const legacyCase=['rights','incidents','inventory','processing','retention','risks','controls','third-party','policies'].includes(m.id);
  const content=el('div'), scheme=m.statuses??m.states??m.stages??[], labels=m.fields??[];
  const paths='/api/modules/'+encodeURIComponent(m.id)+'/records';
  const allRecords=moduleData.records??[];
  const records=m.records??allRecords.filter(r=>r.moduleId===m.id||r.module===m.id);
  const intro=add(el('section'),heading(titleOf(m)),el('p',m.description??'Track synthetic records and their workflow history.'));
  if(legacyCase)intro.append(el('p','Historical register only. Open '+(m.id==='rights'?'Privacy rights':m.id==='incidents'?'Incidents':m.id==='retention'?'Retention':['risks','controls'].includes(m.id)?'Risk and controls':m.id==='third-party'?'Vendor monitoring':m.id==='policies'?'Policies and documents':'Data mapping')+' for the current workflow.','hint'));
  else if(scheme.length)intro.append(el('p','Workflow: '+scheme.map(statusOf).join(' → '),'hint'));
  const form=el('form');
  if(!legacyCase&&actor==='analyst'){
    add(form,labelled('Record title','title','','input'),...labels.map(f=>moduleField(f)),button('Create record','submit'));
    form.onsubmit=e=>{
      e.preventDefault();
      const values=Object.fromEntries(new FormData(form)),{title,...fields}=values;
      for(const f of labels.filter(x=>['boolean','checkbox'].includes(x.type)))fields[fieldKey(f)]=form.elements.namedItem(fieldKey(f)).checked;
      saveModule(paths,{title,fields},'Record created.',form);
    };
    intro.append(form);
  }
  content.append(intro);
  const listing=add(el('section'),heading('Records'));
  if(!records.length)listing.append(el('p','No synthetic records in this module yet.'));
  for(const record of records.slice().reverse()){
    const status=record.status??record.state;
    const card=add(el('article',undefined,'module-record'),add(el('div',undefined,'row'),el('h3',record.title),badge(status)));
    const dl=el('dl');
    for(const f of labels){
      const v=record.fields?.[fieldKey(f)];if(v===undefined||v==='')continue;
      add(dl,el('dt',f.label??fieldKey(f)),el('dd',typeof v==='boolean'?(v?'Yes':'No'):String(v)));
    }
    if(dl.childElementCount)card.append(dl);
    const i=scheme.findIndex(s=>statusOf(s)===status), next=scheme[i+1];
    if(!legacyCase&&next&&i>=0){
      const nextId=statusOf(next), recordPath=paths+'/'+encodeURIComponent(record.id);
      const reviewerStage=['Reviewed','Approved','Recorded'].includes(nextId);
      if(!reviewerStage||actor==='reviewer'){
        const update=el('form');
        add(update,labelled('Transition reason','reason','','input'),button('Move to '+nextId,'submit'));
        update.onsubmit=e=>{e.preventDefault();saveModule(recordPath+'/advance',{reason:new FormData(update).get('reason'),revision:record.revision},'Record advanced.',update)};
        card.append(update);
      }else card.append(el('p','A reviewer is needed for the next stage.','hint'));
      if(actor==='analyst'){
        const edit=el('form');
        add(edit,labelled('Record title','title',record.title,'input'),...labels.map(f=>moduleField(f,record.fields?.[fieldKey(f)])),button('Save record changes','submit'));
        edit.onsubmit=e=>{
          e.preventDefault();const {title,...fields}=Object.fromEntries(new FormData(edit));
          for(const f of labels.filter(x=>['boolean','checkbox'].includes(x.type)))fields[fieldKey(f)]=edit.elements.namedItem(fieldKey(f)).checked;
          saveModule(recordPath+'/update',{title,fields,revision:record.revision},'Record updated.',edit);
        };
        card.append(add(el('details'),el('summary','Edit record'),edit));
      }
    }
    listing.append(card);
  }
  content.append(listing);
  mview.replaceChildren(add(el('div',undefined,'module-grid'),add(el('aside'),add(el('section'),heading('Program modules'),nav)),content));
}
function renderReport(){
  const pane=$('#report-view');
  if(!state||!moduleData)return;
  const {modules,records}=moduleData;
  const inReview=state.assessments.filter(a=>a.status==='in_review').length;
  const failed=state.handoff.filter(p=>p.status==='failed').length;
  const head=add(el('section'),heading('Program summary'),el('p','Counts reflect the local synthetic workspace only.'));
  const metrics=el('div',undefined,'metrics');
  for(const [caption,value] of [['Projects',state.projects.length],['Vendors',state.vendors.length],['Assessments in review',inReview],['Failed handoffs',failed],['Rights cases',(state.rightsCases??[]).length],['Incidents',(state.incidentCases??[]).length],['Data map records',(state.dataMap?.nodes??[]).filter(n=>!n.archivedAt).length],['Program records',records.length],['Audit events',state.audit.length]]){
    metrics.append(add(el('div',undefined,'metric'),el('strong',String(value)),el('span',caption)));
  }
  head.append(metrics);
  const output=add(el('section'),heading('Record counts by stage'));
  const list=el('ul',undefined,'log');
  for(const m of modules){
    const rows=records.filter(r=>r.moduleId===m.id);
    list.append(add(el('li'),el('strong',m.name+': '),document.createTextNode(m.statuses.map(stage=>stage+' '+rows.filter(r=>r.status===stage).length).join(' · '))));
  }
  output.append(list);
  const activity=add(el('section'),heading('Recent audit activity'));
  const log=el('ol',undefined,'log');
  for(const item of state.audit.slice(-15).reverse())log.append(el('li',item.action+' · '+item.actor+' · '+item.at));
  activity.append(log);
  pane.replaceChildren(head,output,activity);
}
function switchView(view){
  const item=$('#show-'+view);
  $('#view-title').textContent=view==='assessments'?'Assessment workspace':item.textContent;
  $('#view-description').textContent=view==='assessments'?
    'Manage project and vendor reviews, then verify an independent approval.':
    'Review and manage synthetic records in this local workspace.';
  $('#workspace-metrics').hidden=view!=='assessments';
  $('#mobile-nav').setAttribute('aria-expanded','false');
  $('#work-tabs').classList.remove('open');
  if(window.matchMedia('(max-width: 760px)').matches&&item.contains(document.activeElement))
    $('#view-title').setAttribute('tabindex','-1'),$('#view-title').focus();

  moduleActive=view==='modules';reportActive=view==='report';
  overview.hidden=view!=='assessments';mview.hidden=!moduleActive;$('#report-view').hidden=!reportActive;$('#rights-view').hidden=view!=='rights';$('#incident-view').hidden=view!=='incidents';$('#data-map-view').hidden=view!=='data-map';$('#dictionary-view').hidden=view!=='dictionary';$('#preferences-view').hidden=view!=='preferences';$('#retention-view').hidden=view!=='retention';$('#risk-controls-view').hidden=view!=='risk-controls';$('#audit-management-view').hidden=view!=='audit-management';$('#vendor-monitoring-view').hidden=view!=='vendor-monitoring';$('#queue-view').hidden=view!=='queue';$('#governance-docs-view').hidden=view!=='governance-docs';$('#trust-center-view').hidden=view!=='trust-center';$('#employee-attestations-view').hidden=view!=='employee-attestations';$('#workflow-studio-view').hidden=view!=='workflow-studio';
  for(const name of ['assessments','rights','incidents','data-map','dictionary','preferences','retention','risk-controls','audit-management','vendor-monitoring','queue','governance-docs','trust-center','employee-attestations','workflow-studio','modules','report']){
    const b=$('#show-'+name),on=view===name;
    b.setAttribute('aria-current',String(on));b.classList.toggle('secondary',!on);
  }
  notice('');
  if(moduleActive||reportActive){
    const pane=reportActive?$('#report-view'):mview;
    pane.replaceChildren(el('p','Loading program records…'));
    if(reportActive)read('/api/state').then(next=>{state=next;return refreshModules()}).catch(error=>{if(reportActive)notice(error.message,true)});
    else refreshModules();
  }else if(view==='rights'){
    $('#rights-view').replaceChildren(el('p','Loading privacy rights cases…'));refreshRights();
  }else if(view==='incidents'){
    $('#incident-view').replaceChildren(el('p','Loading privacy incidents…'));refreshIncidents();
  }else if(view==='data-map'){
    $('#data-map-view').replaceChildren(el('p','Loading data map…'));refreshDataMap();
  }else if(view==='dictionary'){
    $('#dictionary-view').replaceChildren(el('p','Loading governed terms…'));refreshDictionary();
  }else if(view==='preferences'){
    $('#preferences-view').replaceChildren(el('p','Loading privacy notices…'));refreshPreferences();
  }else if(view==='retention'){
    $('#retention-view').replaceChildren(el('p','Loading retention…'));refreshRetention();
  }else if(view==='risk-controls'){
    $('#risk-controls-view').replaceChildren(el('p','Loading risk and controls…'));refreshRiskControls();
  }else if(view==='audit-management'){
    $('#audit-management-view').replaceChildren(el('p','Loading audit plans…'));refreshAuditManagement();
  }else if(view==='vendor-monitoring'){
    $('#vendor-monitoring-view').replaceChildren(el('p','Loading vendor monitoring…'));refreshVendors();
  }else if(view==='queue'){
    $('#queue-view').replaceChildren(el('p','Loading work queue…'));refreshQueue();
  }else if(view==='governance-docs'){
    $('#governance-docs-view').replaceChildren(el('p','Loading documents…'));refreshDocs();
  }else if(view==='trust-center'){
    $('#trust-center-view').replaceChildren(el('p','Loading trust center…'));refreshCenter();
  }else if(view==='employee-attestations'){
    $('#employee-attestations-view').replaceChildren(el('p','Loading assignments…'));refreshEmployeeAdmin();
  }else if(view==='workflow-studio'){
    $('#workflow-studio-view').replaceChildren(el('p','Loading workflow studio…'));refreshStudio();
  }else if(state)render();
}
$('#show-assessments').onclick=()=>switchView('assessments');
$('#show-modules').onclick=()=>switchView('modules');
$('#show-report').onclick=()=>switchView('report');
$('#actor').addEventListener('change',()=>{if(moduleActive&&moduleData)renderModules()});
