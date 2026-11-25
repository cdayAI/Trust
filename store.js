'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const modules = require('./modules');
const assessmentFlow = require('./assessment-workflow');
const forms = require('./assessment-questionnaire');
const rights = require('./rights-workflow');
const incidents = require('./incident-workflow');
const dataMap = require('./data-map');
const dictionary=require('./data-dictionary');
const discovery = require('./discovery-import');
const trustCenter = require('./trust-center');
const employee = require('./employee-attestations');
const preferences = require('./privacy-notices');
const retention = require('./retention-workflow');
const riskControls = require('./risk-controls');
const vendorMonitoring = require('./vendor-monitoring');
const documents = require('./governance-documents');
const programs=new Map([
  ['dictionary',dictionary],['trust-center',trustCenter],['rights',rights],['incidents',incidents],['data-map',dataMap],
  ['privacy-notices',preferences],['retention',retention],['risk-controls',riskControls],['vendor-monitoring',vendorMonitoring],['governance-documents',documents]
]);
const actors = [
  {id:'analyst',name:'Alex Morgan',role:'analyst'},
  {id:'reviewer',name:'Jordan Lee',role:'reviewer'},
  rights.backupActor
];
const id = () => randomUUID();
function fail(status, message) { throw Object.assign(new Error(message), {status}); }
function str(value, field, max=2000, required=true) {
  if (!required && value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(422, field+' must '+(required?'contain 1 to ':'contain at most ')+max+' characters.');
  return value.trim();
}
function find(state, collection, value) {
  const x = state[collection].find(x=>x.id===value);
  if (!x) fail(404,'Record not found.');
  return x;
}
function event(state, actor, action, projectId, entityId, details) {
  const prev = state.audit[state.audit.length-1];
  state.audit.push({id:id(),sequence:prev?prev.sequence+1:1,at:new Date().toISOString(),actor,action,projectId,entityId,details});
}
function createProject(state, actor, body, byId=id()) {
  const row = {id:byId,name:str(body.name,'Project name',120),description:str(body.description,'Project description',2000,false)};
  state.projects.push(row);
  state.handoff.push({id:id(),projectId:row.id,status:'ready',attempts:0,error:null,receipt:null,request:null});
  event(state,actor,'project.created',row.id,row.id,{name:row.name,description:row.description});
  return row;
}
function createVendor(state, actor, body, byId=id()) {
  const p = find(state,'projects',body.projectId);
  if (state.handoff.find(x=>x.projectId===p.id).attempts>0) fail(409,'This project is locked after its first integration attempt. Create a new project to change scope.');
  if (typeof body.usesAI !== 'boolean') fail(422,'Specify whether the vendor uses AI.');
  if (Object.hasOwn(body,'handlesSensitiveData') && typeof body.handlesSensitiveData!=='boolean') fail(422,'Specify whether the vendor handles sensitive information.');
  const row = {id:byId,projectId:p.id,name:str(body.name,'Vendor name',120),description:str(body.description,'Vendor description',2000,false),usesAI:body.usesAI,handlesSensitiveData:body.handlesSensitiveData===true};
  state.vendors.push(row);
  event(state,actor,'vendor.created',p.id,row.id,{name:row.name,description:row.description,usesAI:row.usesAI,handlesSensitiveData:row.handlesSensitiveData});
  createVendorAssessments(state,row);
  return row;
}
function createVendorAssessments(state,row,cycleId){
  const created=[];
  for (const type of row.usesAI?['privacy','ai']:['privacy']) {
    const a={id:id(),vendorId:row.id,projectId:row.projectId,type,status:'draft',answers:{summary:'',safeguards:''},submittedBy:null,decisionBy:null,decisionReason:null,revision:0,...forms.assignment(type,row)};
    if(cycleId)a.monitoringCycleId=cycleId;
    const workflowEvent=assessmentFlow.start(state,a);
    state.assessments.push(a);created.push(a.id);
    event(state,'system','assessment.created',row.projectId,a.id,{vendorId:row.id,type,workflowInstanceId:a.workflowInstanceId,workflowDefinitionVersion:a.workflowDefinitionVersion,workflowEventId:workflowEvent.id,questionnaireId:a.questionnaire.id,questionnaireVersion:a.questionnaire.version,routing:{...a.routing},...(cycleId?{monitoringCycleId:cycleId}:{})});
  }
  return created;
}
function actionAssessment(state, actor, a, action, body) {
  if(!['save','submit','approve','reject'].includes(action)) fail(404,'Action not found.');
  function refuse(status,message,code,workflowEventId=null) {
    event(state,actor,'assessment.refused',a.projectId,a.id,{action,code,workflowEventId,workflowInstanceId:a.workflowInstanceId,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null,actualRevision:a.revision});
    throw Object.assign(new Error(message),{status,code,persistRefusal:true});
  }
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0) refuse(422,'Provide the current assessment revision.','INVALID_EXPECTED_REVISION');
  if(body.expectedRevision!==a.revision) refuse(409,'This assessment changed. Reload before retrying.','STALE_REVISION');
  const details=()=>({type:a.type,revision:a.revision,workflowInstanceId:a.workflowInstanceId,
    workflowDefinitionVersion:a.workflowDefinitionVersion,workflowRevision:a.workflowRevision,questionnaireId:a.questionnaire.id,questionnaireVersion:a.questionnaire.version,routing:{...a.routing}});
  function transition(fields) {
    const result=assessmentFlow.advance(state,a,actor,action,fields);
    if(!result.ok) {
      const status=['ROLE_REQUIRED','INDEPENDENCE_REQUIRED'].includes(result.code)?403:result.code==='TRANSITION_NOT_AVAILABLE'?409:422;
      refuse(status,result.message,result.code,result.event.id);
    }
    return result.event.id;
  }
  if(action==='save'||action==='submit') {
    if(actor!=='analyst') refuse(403,'Only the intake analyst can edit or submit an assessment.','ROLE_REQUIRED');
    if(!['draft','rejected'].includes(a.status)) refuse(409,'Only draft or returned assessments can be edited or submitted.','TRANSITION_NOT_AVAILABLE');
    const flat=Object.fromEntries(['summary','safeguards'].filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
    if(Object.hasOwn(body,'answers')&&(Object.keys(flat).length||body.answers===null)) refuse(422,'Provide a single answers object.','INVALID_ANSWERS');
    const evaluated=forms.evaluate(a.questionnaire,a.answers,Object.hasOwn(body,'answers')?body.answers:flat,action==='submit');
    if(evaluated.code)refuse(422,evaluated.message,evaluated.code);
    const {answers}=evaluated;
    const workflowEventId=action==='submit'?transition({summary:answers.summary,safeguards:answers.safeguards}):null;
    a.revision++;
    a.answers=answers;
    if(action==='submit') {
      a.submittedBy=actor;
      a.decisionBy=null;
      a.decisionReason=null;
    }
    event(state,actor,action==='submit'?'assessment.submitted':'assessment.saved',a.projectId,a.id,{...details(),answers:{...answers},workflowEventId});
    return;
  }
  if(actor!=='reviewer'||actor===a.submittedBy) refuse(403,'An independent reviewer must decide this assessment.','ROLE_REQUIRED');
  if(a.status!=='in_review') refuse(409,'Only a submitted assessment can be decided.','TRANSITION_NOT_AVAILABLE');
  const reason=str(body.reason,'Decision reason',2000,false);
  const workflowEventId=transition(reason?{reason}:{});
  a.revision++;
  a.decisionReason=reason;
  a.decisionBy=actor;
  event(state,actor,action==='approve'?'assessment.approved':'assessment.rejected',a.projectId,a.id,{...details(),reason,submittedBy:a.submittedBy,workflowEventId});
}
function actionHandoff(state, actor, row, action) {
  if (actor!=='analyst') fail(403,'Only the intake analyst can send or retry a handoff.');
  if (!['send','retry'].includes(action)) fail(404,'Action not found.');
  if (row.status==='sent') fail(409,'This handoff has already been delivered.');
  if ((action==='send'&&row.status!=='ready') || (action==='retry'&&row.status!=='failed')) fail(409,'Use retry only after a failed handoff.');
  const vendors=state.vendors.filter(v=>v.projectId===row.projectId);
  const assessments=state.assessments.filter(a=>a.projectId===row.projectId&&!a.monitoringCycleId);
  if (!vendors.length || !vendors.every(v=>(v.usesAI?['privacy','ai']:['privacy']).every(type=>assessments.some(a=>a.vendorId===v.id&&a.type===type&&assessmentFlow.isApproved(state,a))))) fail(409,'All required assessments must be approved by an independent reviewer before handoff.');
  if (!row.request) {
    row.request={handoffId:row.id,project:structuredClone(find(state,'projects',row.projectId)),vendors:structuredClone(vendors),assessments:structuredClone(assessments)};
  }
  row.attempts++;
  event(state,actor,'handoff.attempted',row.projectId,row.id,{attempt:row.attempts,mode:'mock',handoffId:row.id,action});
  if (row.attempts===1) {
    row.status='failed';
    row.error='MOCK_TIMEOUT: simulated integration timeout. No data was sent.';
    event(state,'mock-handoff','handoff.failed',row.projectId,row.id,{attempt:row.attempts,error:row.error});
  } else {
    row.status='sent';
    row.error=null;
    row.receipt='MOCK-'+row.id;
    event(state,'mock-handoff','handoff.sent',row.projectId,row.id,{attempt:row.attempts,receipt:row.receipt,mode:'mock'});
  }
}
function seed() {
  const state={version:1,actors,projects:[],vendors:[],assessments:[],handoff:[],audit:[]};
  const p = createProject(state,'system',{name:'Customer Support Modernization',description:'Synthetic demo: assess two fictional service providers for a support operations pilot.'},'demo-project');
  createVendor(state,'system',{projectId:p.id,name:'HarborDesk',description:'Fictional ticket hosting provider. Does not use AI in this project.',usesAI:false},'harbordesk');
  createVendor(state,'system',{projectId:p.id,name:'Northstar Assist',description:'Fictional service that drafts support replies with AI. Humans review before messages are sent.',usesAI:true},'northstar');
  return state;
}
function openStore(file,{empty=false}={}) {
  function persist(next) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.'+id()+'.tmp';
    try {
      fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});
      fs.renameSync(temp,file);
    } finally {
      fs.rmSync(temp,{force:true});
    }
  }
  let state;
  try { state=JSON.parse(fs.readFileSync(file,'utf8')); }
  catch (error) {
    if (error.code!=='ENOENT') throw error;
    state=empty?{version:1,actors,projects:[],vendors:[],assessments:[],handoff:[],audit:[]}:seed();
    if(!empty)persist(state);
  }
  if (state.version!==1 || !['projects','vendors','assessments','audit','handoff','actors'].every(k=>Array.isArray(state[k]))) throw new Error('Unsupported or invalid state file.');
  if(state.assessments.some(a=>!a.questionnaire&&!a.routing)) {
    const migrated=structuredClone(state);
    for(const a of migrated.assessments.filter(a=>!a.questionnaire&&!a.routing)) {
      Object.assign(a,forms.legacy());
      if(a.workflowInstanceId) {
        event(migrated,'system','assessment.questionnaire-baseline',a.projectId,a.id,{questionnaireId:a.questionnaire.id,questionnaireVersion:a.questionnaire.version,routing:{...a.routing}});
        continue;
      }
      const workflowEvent=assessmentFlow.start(migrated,a,true);
      event(migrated,'system','assessment.workflow-baseline',a.projectId,a.id,{status:a.status,
        assessmentRevision:a.revision,workflowInstanceId:a.workflowInstanceId,workflowDefinitionVersion:a.workflowDefinitionVersion,
        workflowEventId:workflowEvent.id,source:'legacy-synthetic-assessment'});
    }
    persist(migrated);
    state=migrated;
  }
  if(state.privacyPreferences&&!state.privacyNotices){
    const migrated=structuredClone(state);
    const legacy=migrated.privacyPreferences;
    migrated.privacyNotices={revision:legacy.revision,notices:legacy.notices.map(({purposes,...notice})=>notice)};
    persist(migrated);state=migrated;
  }
  for(const a of state.assessments) {forms.verify(a);assessmentFlow.instanceFor(state,a);}
  if(!state.actors.some(a=>a.id===rights.backupActor.id)){
    const migrated=structuredClone(state);
    migrated.actors.push(rights.backupActor);
    persist(migrated);
    state=migrated;
  }
  const discoveryScope=account=>[path.resolve(file),account??null];
  const excludedAudit=e=>!e.action.includes('.')||e.action.startsWith('consent.')||e.action.startsWith('cookies.')||
    (e.action.startsWith('privacy-preferences.')&&!e.action.startsWith('privacy-preferences.notice.'));
  const publicState=()=>{
    const {requesterReceipts,trustCenter:privateCenter,employeeAttestations,privacyPreferences,...safe}=state;
    if(safe.moduleRecords)safe.moduleRecords=modules.model(state).records;
    safe.audit=safe.audit.filter(e=>!excludedAudit(e));
    return documents.stateView(safe);
  };
  return {
    employeeOperatorView:staff=>employee.operatorView(state,staff),
    employeeAssign(staff,actor,account,body){
      const next=structuredClone(state);
      try{if(employee.assign(next,staff,actor,account,body,event)){persist(next);state=next;}}
      catch(error){if(error.persistRefusal){persist(next);state=next;}throw error;}
      return employee.operatorView(state,staff);
    },
    employeeView:seat=>employee.employeeView(state,seat),
    employeeConfirm(seat,body,signer){
      const next=structuredClone(state);
      if(employee.attest(next,seat,body,signer,event)){persist(next);state=next;}
      return employee.employeeView(state,seat);
    },
    trustCenterView:path=>trustCenter.view(state,path),
    trustCenterVisitor:()=>trustCenter.visitor(state),
    portalStatus:grant=>rights.portalModel(state,grant,event).value,
    portalIntake(grant,kind){
      if(typeof kind!=='string')fail(422,'Select a synthetic request type.');
      const next=structuredClone(state);
      const result=rights.portalModel(next,grant,event,kind);
      if(result.created){persist(next);state=next;}
      return result.value;
    },
    previewDiscovery:(actor,body,account)=>discovery.preview(state,actor,body,discoveryScope(account)),
    getState:()=>state,
    publicState,
    getDocuments:actor=>documents.view(state,actor),
    getModules:()=>modules.model(state),
    getRights:()=>rights.view(state),
    getIncidents:()=>incidents.view(state),
    getDictionary:()=>dictionary.view(state),
    getDataMap:()=>dataMap.view(state),
    getLineage:id=>dataMap.lineage(state,id),
    getPreferences:()=>preferences.view(state),
    getRetention:()=>retention.view(state),
    getRiskControls:()=>riskControls.view(state),
    getVendorMonitoring:()=>vendorMonitoring.view(state),
    getProgramAudit:prefix=>state.audit.filter(e=>e.action.startsWith(prefix+'.')),
    visibleAudit:()=>state.audit.filter(e=>!excludedAudit(e)),
    change(parts,actor,body,account) {
      if (!actors.some(a=>a.id===actor)) fail(403,'Select a valid demo identity.');
      if (actor===rights.backupActor.id&&!['rights','governance-documents'].includes(parts[0])) fail(403,'This identity is assigned to rights cases only.');
      if (!body || typeof body!=='object'||Array.isArray(body)) fail(400,'Expected a JSON object.');
      const next=structuredClone(state),program=programs.get(parts[0]);
      const auditStart=next.audit.length;
      const commit=()=>{
        if(account)for(const row of next.audit.slice(auditStart))if(row.actor===actor)row.account=account;
        persist(next);
        state=next;
      };
      let result;
      if (parts.length===1 && ['projects','vendors'].includes(parts[0])) {
        if (actor!=='analyst') fail(403,'Only the intake analyst can create intake records.');
        (parts[0]==='projects'?createProject:createVendor)(next,actor,body);
      } else if(parts.length===3&&parts[0]==='data-map'&&parts[1]==='discovery'&&parts[2]==='apply'){
        try{result=discovery.apply(next,actor,body,event,discoveryScope(account));}
        catch(error){if(error.persistRefusal)commit();throw error;}
        if(!result.changed)return {result,map:dataMap.view(state)};
        commit();return {result,map:dataMap.view(state)};
      } else if(program){
        try{result=program.change(next,parts,actor,body,event,createVendorAssessments);}
        catch(error){
          if(error.persistRefusal)commit();
          throw error;
        }
      } else if (parts[0]==='modules') {
        modules.change(next,parts,actor,body,event);
      } else if (parts.length===3 && parts[0]==='assessments') {
        try {actionAssessment(next,actor,find(next,'assessments',parts[1]),parts[2],body);}
        catch(error) {
          if(error.persistRefusal)commit();
          throw error;
        }
      } else if (parts.length===3&&parts[0]==='handoff') {
        actionHandoff(next,actor,find(next,'handoff',parts[1]),parts[2]);
      } else fail(404,'Endpoint not found.');
      commit();
      return result??(parts[0]==='modules'?modules.model(state):program?program.view(state,actor):publicState());
    }
  };
}
module.exports={openStore};
