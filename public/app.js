'use strict';
const $=(selector)=>document.querySelector(selector);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
const add=(parent,...children)=>{parent.append(...children);return parent};
const button=(caption,type='button',cls)=>{const b=el('button',caption,cls);b.type=type;return b};
const labelled=(label,name,value,kind='textarea',required=true)=>{
  const l=el('label',label), field=el(kind);
  field.name=name;field.value=value??'';field.required=required;
  if(kind==='textarea'){field.rows=2;field.maxLength=2000}
  else field.maxLength=120;
  return add(l,field);
};
let state,selected,actor='analyst',busy=false,localSession;
function scopeUrl(url){
  if(!localSession?.authenticated||url.startsWith('/api/session'))return url;
  const target=new URL(url,location.origin);
  if(target.origin!==location.origin||!target.pathname.startsWith('/api/'))throw Error('Only local workbench requests are supported.');
  target.searchParams.set('workspace',localSession.workspace);
  return target.pathname+target.search;
}
function notice(s,error=false){const n=$('#notice');n.textContent=s;n.className=error?'error':'success'}
async function read(url,options){
  const headers=new Headers(options?.headers);
  if(localSession)headers.delete('X-Demo-Actor');
  const r=await fetch(scopeUrl(url),{...options,headers}), data=await r.json();
  if(localSession?.authenticated&&!url.startsWith('/api/session')&&(r.status===401||r.status===403)){
    // Ordinary permission refusals keep the page; an expired or changed context does not.
    await checkContext();
  }
  if(!r.ok)throw Object.assign(Error(data.error||data.message||'Request failed.'),{status:r.status,fileErrors:Array.isArray(data.fileErrors)?data.fileErrors:undefined});
  return data;
}
async function write(url,body,message,after){
  if(busy)return;
  busy=true;
  try{
    const previous=state;
    const next=await read(url,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Actor':actor},body:JSON.stringify(body)});
    state=next;
    if(after)after(next,previous);
    render();notice(typeof message==='function'?message(next):message);
  }catch(error){notice(error.message,true);if(error.status===409&&/revision|reload|changed/i.test(error.message)){const b=button('Reload latest','button','secondary');b.onclick=async()=>{try{state=await read('/api/state');render();notice('Latest records loaded.')}catch(e){notice(e.message,true)}};$('#notice').append(document.createTextNode(' '),b)}}
  finally{busy=false}
}
function assessmentInput(form,a){return {...Object.fromEntries(new FormData(form)),expectedRevision:a.revision}}
function heading(s){return el('h2',s)}
function badge(s){return el('span',String(s).replaceAll('_',' '),'badge')}
function renderAssessment(parent,a){
  const card=add(el('div',undefined,'assessment'),add(el('div',undefined,'row'),el('h3',a.type==='ai'?'AI-risk assessment':'Privacy assessment'),badge(a.status)));
  card.id='work-record-'+a.id;
  const root='/api/assessments/'+encodeURIComponent(a.id);
  const q=a.questionnaire;
  card.append(el('p',q.label+' · Form v'+q.version+' · Workflow v'+a.workflowDefinitionVersion+' · Record revision '+a.revision,'hint'));
  card.append(el('p','Routing: '+a.routing.reason,'hint'));
  if(a.routing.configurationVersion)card.append(el('p','Configuration v'+a.routing.configurationVersion+' · Rule '+a.routing.ruleId,'hint'));
  if(a.monitoringCycleId)card.append(el('p','Vendor monitoring reassessment · '+a.id,'hint'));
  if(actor==='analyst'&&['draft','rejected'].includes(a.status)){
    if(a.decisionReason)card.append(el('p','Returned by reviewer: '+a.decisionReason,'hint'));
    const f=el('form');
    const actions=el('div',undefined,'actions');
    const save=button('Save draft','button','secondary');
    const submit=button('Submit for review','submit');
    const inputs=new Map();
    for(const question of q.questions){
      const label=el('label',question.label+(question.required?' *':''));
      const field=el(question.kind==='choice'?'select':question.kind==='integer'?'input':'textarea');
      field.name=question.id;field.required=!!question.required;
      if(question.kind==='choice'){
        const blank=el('option','Select an answer');blank.value='';field.append(blank);
        for(const choice of question.options){const opt=el('option',choice);opt.value=choice;field.append(opt)}
      }else if(question.kind==='integer'){field.inputMode='numeric';field.maxLength=10;field.pattern='(?:0|-?[1-9][0-9]{0,8})'}
      else{field.rows=2;field.maxLength=2000}
      field.value=a.answers[question.id]??'';
      inputs.set(question.id,{label,field,question});f.append(add(label,field));
    }
    function refreshBranches(){
      for(const {label,field,question} of inputs.values()){
        const parent=question.when?inputs.get(question.when.question).field:null;
        const active=!parent||(!parent.disabled&&parent.value===question.when.equals);
        label.hidden=!active;field.disabled=!active;
        if(!active)field.value='';
      }
    }
    f.onchange=refreshBranches;refreshBranches();
    function payload(){return {expectedRevision:a.revision,answers:Object.fromEntries(new FormData(f))}}
    save.onclick=()=>write(root+'/save',payload(),'Draft saved.');
    f.onsubmit=(e)=>{e.preventDefault();write(root+'/submit',payload(),'Sent for independent review.')};
    add(f,add(actions,save,submit));card.append(f);
  }else{
    for(const question of q.questions){
      if(question.when&&a.answers[question.when.question]!==question.when.equals)continue;
      if(a.answers[question.id])card.append(el('p',question.label+': '+a.answers[question.id]));
    }
    if(a.decisionReason)card.append(el('p','Reviewer decision: '+a.decisionReason));
    if(a.status==='in_review'&&actor==='reviewer'){
      const f=el('form');
      add(f,labelled('Decision reason','reason','','textarea',false),add(el('div',undefined,'actions'),button('Approve assessment','submit'),button('Return for changes','submit','secondary')));
      f.onsubmit=(e)=>{e.preventDefault();const action=e.submitter?.textContent==='Return for changes'?'reject':'approve';write(root+'/'+action,assessmentInput(f,a),action==='approve'?'Assessment approved.':'Assessment returned for changes.')};card.append(f);
    }else if(a.status==='in_review')card.append(el('p','Waiting for the independent reviewer.','hint'));
  }
  parent.append(card);
}
function renderWorkspaceMetrics(){
  const overview=$('#workspace-metrics');
  if(!state||overview.hidden)return;
  const cards=[
    ['Projects',state.projects.length,'Synthetic workspace records'],
    ['In review',state.assessments.filter(x=>x.status==='in_review').length,'Awaiting independent review'],
    ['Approved',state.assessments.filter(x=>x.status==='approved').length,'Recorded assessment decisions']
  ];
  overview.replaceChildren(...cards.map(([label,count,caption])=>add(el('div',undefined,'workspace-metric'),el('span',label),el('strong',String(count)),el('small',caption))));
}
function prepareDemoIdentity(){
  const role=$('#actor');
  role.replaceChildren(...state.actors.map(a=>{const o=el('option',a.name);o.value=a.id;return o}));
  role.value=actor;
}
function render(){
  renderWorkspaceMetrics();
  selected=state.projects.some(p=>p.id===selected)?selected:state.projects[0]?.id;
  const projects=$('#projects');projects.replaceChildren();
  for(const p of state.projects){const b=button(p.name,'button','secondary');if(p.id===selected)b.setAttribute('aria-current','true');b.onclick=()=>{selected=p.id;notice('');render()};projects.append(b)}
  const pf=$('#project-form');for(const child of pf.elements)child.disabled=actor!=='analyst';
  pf.onsubmit=e=>{e.preventDefault();write('/api/projects',Object.fromEntries(new FormData(pf)),'Project created.',(next,old)=>{selected=next.projects.find(p=>!old.projects.some(q=>q.id===p.id))?.id;pf.reset()})};
  const ws=$('#workspace');ws.replaceChildren();
  const p=state.projects.find(x=>x.id===selected);if(!p)return;
  const vendors=state.vendors.filter(v=>v.projectId===p.id);
  const handoff=state.handoff.find(o=>o.projectId===p.id);
  ws.append(add(el('section'),heading(p.name),el('p',p.description||'No description.'),el('p',vendors.length+' vendors · '+state.assessments.filter(a=>a.projectId===p.id).length+' assessments','hint')));
  for(const v of vendors){
    const card=add(el('section'),add(el('div',undefined,'row'),heading(v.name),badge(v.usesAI?'Uses AI':'No AI declared')));
    if(v.description)card.append(el('p',v.description));
    for(const a of state.assessments.filter(a=>a.vendorId===v.id))renderAssessment(card,a);
    ws.append(card);
  }
  if(actor==='analyst'&&(!handoff||!handoff.attempts)){
    const f=el('form');const cb=el('input');cb.type='checkbox';cb.name='usesAI';
    const sensitive=el('input');sensitive.type='checkbox';sensitive.name='handlesSensitiveData';
    add(f,labelled('Vendor name','name','','input'),labelled('Vendor description','description','','textarea',false),add(el('label'),cb,document.createTextNode('Vendor uses AI')),add(el('label'),sensitive,document.createTextNode('Vendor handles sensitive information')),button('Add vendor','submit'));
    f.onsubmit=e=>{e.preventDefault();const form=new FormData(f);write('/api/vendors',{projectId:p.id,name:form.get('name'),description:form.get('description'),usesAI:cb.checked,handlesSensitiveData:sensitive.checked},'Vendor and required assessments added.')};
    ws.append(add(el('section'),heading('Add a vendor'),f));
  }
  if(handoff){
    const panel=add(el('section'),add(el('div',undefined,'row'),heading('Mock integration handoff'),badge(handoff.status)),el('p','Local simulation only. The first eligible attempt fails by design; retry resends the same approved package.'));
    if(handoff.error)panel.append(el('p',handoff.error,'error'));
    if(handoff.receipt){panel.append(el('p','Mock receipt: '+(typeof handoff.receipt==='string'?handoff.receipt:JSON.stringify(handoff.receipt)),'success'))}
    const a=state.assessments.filter(x=>x.projectId===p.id&&!x.monitoringCycleId);
    if(actor==='analyst'&&handoff.status!=='sent'){
      const action=handoff.status==='failed'?'retry':'send',b=button(action==='retry'?'Retry mock handoff':'Send mock handoff');
      b.disabled=!a.length||a.some(x=>x.status!=='approved');
      b.onclick=()=>write('/api/handoff/'+encodeURIComponent(handoff.id)+'/'+action,{},next=>next.handoff.find(x=>x.id===handoff.id).status==='failed'?'Mock failure captured. The same package is ready to retry.':'Mock handoff accepted.');
      panel.append(b);
      if(b.disabled)panel.append(el('p','Approve every associated assessment before handoff.','hint'));
    }
    ws.append(panel);
  }
  const audit=add(el('section'),heading('Project audit history'));
  const log=el('ol',undefined,'log');
  for(const item of state.audit.filter(e=>e.projectId===p.id).slice().reverse()){
    const details=add(el('details'),el('summary',item.action+' · '+item.actor),el('small',item.at),el('pre',JSON.stringify(item.details,null,2)));
    log.append(add(el('li'),details));
  }
  audit.append(log);ws.append(audit);
}
async function checkContext(){
  if(!localSession?.authenticated)return;
  const current=await fetch('/api/session').then(x=>x.json()).catch(()=>null);
  if(current&&(!current.authenticated||current.workspace!==localSession.workspace||current.account!==localSession.account)){
    $('#workbench').hidden=true;location.reload();
  }
}
window.addEventListener('focus',checkContext);
window.addEventListener('pageshow',event=>{if(event.persisted)checkContext()});
function sessionPost(operation,body){return read('/api/session/'+operation,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
})}
$('#local-login').onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget, submit=form.querySelector('button');
  if(submit.disabled)return;
  submit.disabled=true;
  try{await sessionPost('login',Object.fromEntries(new FormData(form)));form.reset();location.reload()}
  catch(error){form.elements.code.value='';$('#local-error').textContent=error.message;submit.disabled=false}
};
$('#local-context').onsubmit=async event=>{
  event.preventDefault();
  try{
    await sessionPost('switch',{current:localSession.workspace,workspace:$('#local-workspace').value});
    $('#workbench').hidden=true;location.reload();
  }catch(error){notice(error.message,true)}
};
$('#local-logout').onclick=async()=>{
  try{await sessionPost('logout',{});$('#workbench').hidden=true;location.reload()}
  catch(error){notice(error.message,true)}
};
function showSkipDestination(id,label){
  const link=$('#skip-to-content');
  link.href='#'+id;link.textContent=label;link.hidden=false;
}
async function start(){
  try{
    const session=await read('/api/session');
    if(session.mode==='local-isolated'||session.mode==='corporate-oidc'){
      localSession=session;
      if(!session.authenticated){
        if(session.mode==='corporate-oidc'){
          $('#signin-title').textContent='Sign in with your organization';
          $('#local-signin-help').hidden=true;
          $('#local-login').hidden=true;
          $('#corporate-login').hidden=false;
          if(new URLSearchParams(location.search).get('signin')==='denied'){
            $('#local-error').textContent='Sign-in failed or this account does not have workspace access.';
            history.replaceState(null,'','/');
          }
        }
        $('#local-signin').hidden=false;showSkipDestination('local-signin','Skip to sign-in');return
      }
      actor=session.actor;
      const workspace=$('#local-workspace');
      workspace.replaceChildren(...session.workspaces.map(x=>{const option=el('option',x.label);option.value=x.id;return option}));
      workspace.value=session.workspace;
      $('#local-account').textContent=session.account+' · '+actor;
      $('#local-context').hidden=false;
    }else if(session.mode==='synthetic-demo'){$('#demo-identity').hidden=false}
    else throw Error('Unknown workspace mode.');
    state=await read('/api/state');
    const auditLink=$('#audit-export');
    auditLink.href=scopeUrl('/api/audit/export');
    auditLink.hidden=!!localSession&&!localSession.capabilities.workspaceAudit;
    if(localSession){
      const allowed=localSession.capabilities.views;
      for(const b of $('#work-tabs').querySelectorAll('button[id^="show-"]'))b.hidden=!allowed.includes(b.id.slice(5));
      for(const group of $('#work-tabs').querySelectorAll('.nav-group'))group.hidden=!group.querySelector('button:not([hidden])');
      if(!allowed.length)throw Error('No workspace views are available for this account.');
      if(allowed.includes('my-work')&&ownLinkPattern.test(location.hash))switchView('my-work',{keepMyWorkLink:true});
      else switchView(allowed[0],{keepMyWorkLink:true});
    }else{prepareDemoIdentity();switchView('home');}
    $('#workbench').hidden=false;showSkipDestination('workbench','Skip to workbench');
    if(localSession)openMyWorkLocation();
  }catch(error){
    $('#local-signin').hidden=false;$('#local-login').hidden=true;showSkipDestination('local-signin','Skip to sign-in');
    $('#local-error').textContent='Unable to load workbench: '+error.message;
  }
}
// Update the shared role before view-specific listeners render.
$('#actor').addEventListener('change',event=>{
  if(localSession||!state)return;
  actor=event.currentTarget.value;
  notice('');
  render();
});
document.addEventListener('DOMContentLoaded',start,{once:true});


$('#glass-toggle').onclick=event=>{
  const button=event.currentTarget;
  const enabled=document.body.classList.toggle('solid-surfaces');
  button.setAttribute('aria-pressed',String(enabled));
};
$('#mobile-nav').onclick=event=>{
  const button=event.currentTarget;
  const open=button.getAttribute('aria-expanded')!=='true';
  button.setAttribute('aria-expanded',String(open));
  $('#work-tabs').classList.toggle('open',open);
};
