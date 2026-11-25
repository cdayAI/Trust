'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {hasLegacySnapshot}=require('./durable-storage');
const operatorJobs = require('./operator-jobs');
const modules = require('./modules');
const reportRuns=require('./reporting-runs');
const reportSchedules=require('./report-schedules');
const assessmentFlow = require('./assessment-workflow');
const forms = require('./assessment-questionnaire');
const assessmentConfig=require('./assessment-config');
const processingRegister=require('./processing-register');
const rights = require('./rights-workflow');
const requesterRelease=require('./requester-release');
const rightsRetrieval=require('./rights-retrieval');
const deadlines = require('./rights-deadline-policy');
const requesterIntakeForm=require('./requester-intake-form');
const incidents = require('./incident-workflow');
const assessmentIncident=require('./assessment-incident');
const dataMap = require('./data-map');
const dictionary=require('./data-dictionary');
const discovery = require('./discovery-import');
const discoveryRuns=require('./discovery-runs');
const trustCenter = require('./trust-center');
const employee = require('./employee-attestations');
const training = require('./training');
const preferences = require('./privacy-notices');
const retention = require('./retention-workflow');
const riskControls = require('./risk-controls');
const auditManagement = require('./audit-management');
const auditVerification=require('./audit-verification');
const ethics = require('./ethics-cases');
const maturityPlanning = require('./maturity-planning');
const vendorMonitoring = require('./vendor-monitoring');
const documents = require('./governance-documents');
const documentScope = require('./document-scope');
const documentReviewSeats=require('./document-review-seats');
const rightsCaseScope=require('./rights-case-scope');
const programs=new Map([
  ['assessment-config',assessmentConfig],['processing-register',processingRegister],
  ['dictionary',dictionary],['trust-center',trustCenter],['rights',rights],['incidents',incidents],['data-map',dataMap],
  ['privacy-notices',preferences],['retention',retention],['risk-controls',riskControls],['audit-management',auditManagement],['maturity-planning',maturityPlanning],['vendor-monitoring',vendorMonitoring],['governance-documents',documents]
]);
const identityAdmin=require('./identity-admin');
const directoryLifecycle=require('./directory-lifecycle');
const groupGovernance=require('./group-governance');
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
function createVendorAssessments(state,row,cycleId,engagementId){
  const created=[];
  for (const type of row.usesAI?['privacy','ai']:['privacy']) {
    const a={id:id(),vendorId:row.id,projectId:row.projectId,type,status:'draft',answers:{summary:'',safeguards:''},submittedBy:null,decisionBy:null,decisionReason:null,revision:0,...(assessmentConfig.assignment(state,type,row)??forms.assignment(type,row))};
    if(cycleId)a.monitoringCycleId=cycleId;
    if(engagementId)a.vendorEngagementId=engagementId;
    const workflowEvent=assessmentFlow.start(state,a);
    state.assessments.push(a);created.push(a.id);
    event(state,'system','assessment.created',row.projectId,a.id,{vendorId:row.id,type,workflowInstanceId:a.workflowInstanceId,workflowDefinitionVersion:a.workflowDefinitionVersion,workflowEventId:workflowEvent.id,questionnaireId:a.questionnaire.id,questionnaireVersion:a.questionnaire.version,routing:{...a.routing},...(cycleId?{monitoringCycleId:cycleId}:{}),...(engagementId?{vendorEngagementId:engagementId}:{})});
  }
  return created;
}
function actionAssessment(state, actor, a, action, body, account) {
  const identity=account??actor;
  if(!['save','submit','approve','reject'].includes(action)) fail(404,'Action not found.');
  function refuse(status,message,code,workflowEventId=null) {
    event(state,actor,'assessment.refused',a.projectId,a.id,{action,code,workflowEventId,workflowInstanceId:a.workflowInstanceId,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null,actualRevision:a.revision});
    throw Object.assign(new Error(message),{status,code,persistRefusal:true});
  }
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0) refuse(422,'Provide the current assessment revision.','INVALID_EXPECTED_REVISION');
  if(body.expectedRevision!==a.revision) refuse(409,'This assessment changed. Reload before retrying.','STALE_REVISION');
  const details=()=>({type:a.type,revision:a.revision,workflowInstanceId:a.workflowInstanceId,
    workflowDefinitionVersion:a.workflowDefinitionVersion,workflowRevision:a.workflowRevision,questionnaireId:a.questionnaire.id,questionnaireVersion:a.questionnaire.version,routing:{...a.routing},
    ...(a.vendorEngagementId?{vendorEngagementId:a.vendorEngagementId,monitoringCycleId:a.monitoringCycleId}:{})});
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
    if(a.vendorEngagementId&&state.vendorMonitoring?.cases.find(x=>x.id===a.vendorEngagementId)?.ownerAccount!==identity)
      refuse(403,'Only the engagement owner account can change this assessment.','ENGAGEMENT_OWNER_REQUIRED');
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
      if(a.vendorEngagementId){a.submittedByAccount=identity;a.decisionByAccount=null;}
      a.decisionBy=null;
      a.decisionReason=null;
    }
    event(state,actor,action==='submit'?'assessment.submitted':'assessment.saved',a.projectId,a.id,{...details(),answers:{...answers},workflowEventId});
    return;
  }
  if(actor!=='reviewer'||actor===a.submittedBy||a.vendorEngagementId&&identity===a.submittedByAccount) refuse(403,'An independent reviewer must decide this assessment.','ROLE_REQUIRED');
  if(a.status!=='in_review') refuse(409,'Only a submitted assessment can be decided.','TRANSITION_NOT_AVAILABLE');
  const reason=str(body.reason,'Decision reason',2000,false);
  const workflowEventId=transition(reason?{reason}:{});
  a.revision++;
  a.decisionReason=reason;
  a.decisionBy=actor;
  if(a.vendorEngagementId)a.decisionByAccount=identity;
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
function openStore(file,{empty=false,storage,scopeDocuments=false,manualAttachmentReview=false,scopeRights=false,largePdf=false,reportWorkerEnabled=false}={}) {
  let saveSnapshot,localSnapshotGeneration=0;
  const intakeViewInstance=randomUUID();
  function persist(next) {
    if(storage){
      if(!saveSnapshot)throw Error('Write outside storage transaction.');
      saveSnapshot(next);
      return;
    }
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.'+id()+'.tmp';
    try {
      fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});
      fs.renameSync(temp,file);
      localSnapshotGeneration++;
    } finally {
      fs.rmSync(temp,{force:true});
    }
  }
  let state;
  const fresh=()=>empty?{version:1,actors,projects:[],vendors:[],assessments:[],handoff:[],audit:[]}:seed();
  const workbench='workbench';
  function initialize(stored){
    state=stored;
    if(state===undefined){
      if(storage&&hasLegacySnapshot(file))throw Error('Legacy workbench state exists; migrate it explicitly before enabling SQLite.');
      state=fresh();
      if(!empty)persist(state);
    }
    if (state.version!==1 || !['projects','vendors','assessments','audit','handoff','actors'].every(k=>Array.isArray(state[k]))) throw new Error('Unsupported or invalid state file.');
    if(manualAttachmentReview){
      const next=structuredClone(state);
      if(documents.enableManualReview(next)){persist(next);state=next;}
    }
    if(scopeRights&&state.rightsCaseAccountScope===undefined){
      const next=structuredClone(state);
      next.rightsCaseAccountScope=rightsCaseScope.empty();
      persist(next);state=next;
    }
    if(scopeDocuments&&state.documentAccessScope===undefined){
      const next=structuredClone(state);
      next.documentAccessScope={version:1,revision:0,grants:[]};
      persist(next);state=next;
    }
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
    assessmentConfig.verifyBook(state);
    vendorMonitoring.verify(state);
    for(const a of state.assessments){
      if(a.routing?.id?.startsWith('configured-'))assessmentConfig.verifyPinned(state,a);else forms.verify(a);
      assessmentFlow.instanceFor(state,a);
    }
    if(!state.actors.some(a=>a.id===rights.backupActor.id)){
      const migrated=structuredClone(state);
      migrated.actors.push(rights.backupActor);
      persist(migrated);
      state=migrated;
    }
  }
  if(storage){
    storage.write(workbench,(snapshot,save)=>{
      saveSnapshot=save;
      try{initialize(snapshot);}finally{saveSnapshot=undefined;}
    });
  }else{
    let stored;
    try{stored=JSON.parse(fs.readFileSync(file,'utf8'))}
    catch(error){if(error.code!=='ENOENT')throw error;}
    initialize(stored);
  }
  const discoveryScope=account=>[path.resolve(file),account??null];
  const excludedAudit=e=>!e.action.includes('.')||e.action.startsWith('consent.')||e.action.startsWith('cookies.')||
    (e.action.startsWith('privacy-preferences.')&&!e.action.startsWith('privacy-preferences.notice.'));
  const publicState=()=>{
    const {fixtureMigrationReceipt,requesterReceipts,requesterReleases,rightsRetrievals,trustCenter:privateCenter,employeeAttestations,training:privateTraining,privacyPreferences,identityAdministration,directoryLifecycle:privateDirectory,groupGovernance:privateGroupGovernance,documentAccessScope,documentReviewerAssignments,rightsCaseAccountScope,ethicsCases,rightsDeadlinePolicy,requesterIntakeForm:privateRequesterForm,maturityPlanning:privatePlanning,assessmentConfiguration:privateAssessmentConfig,processingRegister:privateProcessingRegister,incidentPolicyBook:privateIncidentPolicy,reportRuns:privateReportRuns,reportScheduleBook:privateReportSchedules,discoveryRuns:privateDiscoveryRuns,auditRemediation:privateAuditRemediation,...safe}=state;
    if(safe.rightsCases)safe.rightsCases=safe.rightsCases.map(({extensionRequester,requesterIntake,...row})=>row);
    if(safe.moduleRecords)safe.moduleRecords=modules.model(state).records;
    if(safe.incidentCases)safe.incidentCases=safe.incidentCases.map(({ownerAccount,reviewRequestedByAccount,...row})=>row);
    delete safe.operatorJobs;
    delete safe.operatorAuditReceipts;
    safe.audit=safe.audit.filter(e=>!excludedAudit(e));
    return documents.stateView(safe);
  };
  function requireCurrentOperatorSession(caller) {
    const membership = identityAdmin.record(state, caller.account);
    if (membership.disabled || membership.revision !== caller.generation) fail(401, 'Sign in to a local workspace.');
  }
  function projectRights(snapshot,context){
    const model=rights.view(context?.role==='case-operator'?rightsCaseScope.viewState(snapshot,context):snapshot);
    const delegation=rightsCaseScope.settings(snapshot,context);
    const intakeSettings=requesterIntakeForm.settings(snapshot,context);
    if(!['analyst','reviewer'].includes(context?.role))model.cases=model.cases.map(({requesterIntake,...row})=>row);
    else if(context.activeReleaseBinding&&snapshot.requesterReceipts?.length){
      const retrievalOffered=rightsRetrieval.offerCaseIds(snapshot,context);
      model.cases=model.cases.map(row=>{
        const resultDelivery=requesterRelease.presentation(snapshot,row,context);
        if(resultDelivery)row={...row,resultDelivery};
        return retrievalOffered.has(row.id)?{...row,retrievalOffered:true}:row;
      });
    }
    return {...model,...(delegation?{delegation}:{}),...(intakeSettings?{intakeSettings}:{})};
  }
  function intakeViewBasis(snapshot,ctx){
    // Requester result grants can expire independently while their server-side
    // closures are being read. Conservatively keep the full response for any
    // modeled requester result bindings rather than applying a stale delta.
    if(ctx.role!=='analyst'||(ctx.activeReleaseBinding&&snapshot.requesterReceipts?.length))return null;
    return JSON.stringify([ctx.account,ctx.generation,!!ctx.rightsEnabled,!!ctx.intakeEnabled,
      new Date().toISOString().slice(0,10),rightsCaseScope.intakeTimeMarker(snapshot,ctx)]);
  }
  function intakeVersion(generation,basis){
    return basis===null?null:createHash('sha256').update(JSON.stringify([intakeViewInstance,generation,basis])).digest('hex');
  }
  function readVersionedRights(snapshot,ctx,generation){
    const before=intakeViewBasis(snapshot,ctx),model=projectRights(snapshot,ctx);
    const after=intakeViewBasis(snapshot,ctx);
    return {model,version:before===after?intakeVersion(generation,after):null};
  }
  const documentCapabilities={largePdf:!!storage&&largePdf};
  const documentModel=(actor,account,review)=>review?.limited?documentReviewSeats.limitedModel(state,review):
    documentReviewSeats.projection(state,documents.view(state,actor,documentCapabilities,account),review);
  const applyProgram = (snapshot, parts, actor, body, appendEvent, account) =>
    programs.get(parts[0]).change(snapshot, parts, actor, body, appendEvent, createVendorAssessments, account, documentCapabilities);
  let membershipGeneration=-1, membershipState={};
  const operations={
    groupGovernanceView:context=>groupGovernance.operatorView(state,context),
    scopedApplications:context=>groupGovernance.list(state,context),
    groupGovernanceChange(context,body){
      const next=structuredClone(state);
      const result=groupGovernance.change(next,context,body,event);
      persist(next);
      state=next;
      return result;
    },
    readOperatorJobs(caller, jobId) {
      requireCurrentOperatorSession(caller);
      return operatorJobs.read(state, caller, jobId);
    },
    changeOperatorJob(caller, operation, jobId, body) {
      if (!storage) throw new Error('Operator jobs require transactional storage.');
      // Check revocation again on the snapshot locked for this write.
      requireCurrentOperatorSession(caller);
      const next = structuredClone(state);
      const outcome = operatorJobs.change(next, caller, operation, jobId, body, event, applyProgram);
      if (outcome.changed) { persist(next); state = next; }
      return outcome;
    },
    identityMembership(id){
      if(!storage)return identityAdmin.record(state,id);
      const {generation,payload}=storage.readSince(workbench,membershipGeneration);
      if(generation!==membershipGeneration){
        // Keep only the identity projection, not a second workbench snapshot.
        membershipState={identityAdministration:payload?.identityAdministration};
        membershipGeneration=generation;
      }
      return identityAdmin.record(membershipState,id);
    },
    directoryView:context=>directoryLifecycle.view(state,context),
    directoryChange(context,body){
      const next=structuredClone(state);
      const result=directoryLifecycle.change(next,context,body,(s,action,target,details)=>{
        event(s,context.role,action,null,target,details);
        s.audit.at(-1).account=context.account;
      });
      persist(next);state=next;
      return result;
    },
    identityAdminView:(seats,at)=>identityAdmin.view(state,seats,at),
    identityAdminChange(seats,at,caller,body){
      requireCurrentOperatorSession(caller);
      const next=structuredClone(state);
      const result=identityAdmin.change(next,seats,at,caller.account,body,event);
      persist(next);
      state=next;
      return result;
    },
    getEthicsCases:(role,account)=>ethics.view(state,role,account),
    getEthicsExport:(id,role,account)=>ethics.redactedExport(state,id,role,account),
    changeEthics(caller,action,id,body){
      requireCurrentOperatorSession(caller);
      const next=structuredClone(state);
      const result=ethics.change(next,caller.actor,caller.account,action,id,body);
      persist(next);
      state=next;
      return result;
    },
    trainingOperatorView:learners=>training.operatorView(state,learners),
    trainingAdmin(learners,caller,action,body){
      requireCurrentOperatorSession(caller);
      const next=structuredClone(state);
      try{if(training.admin(next,learners,caller.actor,caller.account,action,body,event)){persist(next);state=next;}}
      catch(error){if(error.persistRefusal){persist(next);state=next;}throw error;}
      return training.operatorView(state,learners);
    },
    trainingQuery:(seat,action,body)=>training.query(state,seat,action,body),
    trainingProgress(seat,action,body,sign){
      const next=structuredClone(state);
      const changed=training.progress(next,seat,action,body,sign,event);
      const view=training.learnerView(changed?next:state,seat,body.assignment);
      if(changed){persist(next);state=next;}
      return view;
    },
    employeeOperatorView:staff=>employee.operatorView(state,staff),
    employeeAssign(staff,caller,body){
      requireCurrentOperatorSession(caller);
      const next=structuredClone(state);
      try{if(employee.assign(next,staff,caller.actor,caller.account,body,event)){persist(next);state=next;}}
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
    portalStatus:grant=>{
      const status=rights.portalModel(state,grant,event).value;
      return requesterRelease.publicResult(state,grant).status==='available'?{...status,resultAvailable:true}:status;
    },
    portalResult:grant=>requesterRelease.publicResult(state,grant),
    getRightsRetrieval(ctx,id){
      requireCurrentOperatorSession(ctx);
      return rightsRetrieval.inspect(state,id,ctx);
    },
    changeRightsRetrieval(ctx,id,action,body){
      requireCurrentOperatorSession(ctx);
      const next=structuredClone(state);
      const outcome=rightsRetrieval.change(next,id,action,ctx,body,(snapshot,role,kind,project,entity,details)=>{
        event(snapshot,role,kind,project,entity,details);snapshot.audit.at(-1).account=ctx.account;
      });
      persist(next);state=next;
      return outcome;
    },
    changeRequesterRelease(ctx,id,action,body){
      requireCurrentOperatorSession(ctx);
      const next=structuredClone(state);
      requesterRelease.change(next,id,action,ctx,body,(snapshot,role,eventName,project,target,details)=>{
        event(snapshot,role,eventName,project,target,details);
        snapshot.audit.at(-1).account=ctx.account;
      });
      persist(next);state=next;
      return projectRights(state,ctx);
    },
    portalIntake(grant,request){
      if(typeof request.kind!=='string')fail(422,'Select a synthetic request type.');
      const next=structuredClone(state);
      const result=rights.portalModel(next,grant,event,request);
      if(result.created){persist(next);state=next;}
      return result.value;
    },
    previewDiscovery:(actor,body,account)=>discovery.preview(state,actor,body,discoveryScope(account)),
    discoveryRunModel:()=>discoveryRuns.view(state),
    hasDiscoveryRehearsals:()=>discoveryRuns.hasSavedRuns(state),
    changeDiscoveryRun(ctx,id,action,body){
      requireCurrentOperatorSession(ctx);
      const next=structuredClone(state);
      const result=discoveryRuns.change(next,ctx,id,action,body,(target,role,kind,project,entity,details)=>{
        event(target,role,kind,project,entity,details);target.audit.at(-1).account=ctx.account;
      });
      if(result.changed){persist(next);state=next;}
      return {run:result.run,model:discoveryRuns.view(state),changed:result.changed};
    },
    getState:()=>state,
    publicState,
    getDocuments(actor,account,review){
      if(review?.limited)requireCurrentOperatorSession(review);
      return documentModel(actor,account,review);
    },
    assignDocumentReviewer(ctx,doc,edition,body){
      requireCurrentOperatorSession(ctx);
      const next=structuredClone(state);
      documentReviewSeats.update(next,ctx,doc,edition,body,(state,actor,kind,project,id,details)=>{
        event(state,actor,kind,project,id,details);state.audit.at(-1).account=ctx.account;
      });
      persist(next);state=next;
      return documentModel(ctx.role,ctx.account,ctx);
    },
    getCaseDocuments(ctx){
      requireCurrentOperatorSession(ctx);
      if(ctx.enabled)return documentScope.list(state,ctx);
      const baseline=documents.view(rightsCaseScope.viewState(state,ctx),ctx.role);
      return state.documentAccessScope===undefined?baseline:{...baseline,documents:[]};
    },
    documentAccessView:ctx=>documentScope.boardView(state,ctx),
    documentAccessTransition(ctx,body){
      const next=structuredClone(state);
      const result=documentScope.transition(next,ctx,body,(target,action,grant,details)=>{
        event(target,ctx.role,action,null,grant.id,{
          document:grant.document,edition:grant.edition,account:grant.account,level:grant.level,...details
        });
        target.audit.at(-1).account=ctx.account;
      });
      persist(next);state=next;
      return result;
    },
    readCaseDocument(parts,ctx,body){
      requireCurrentOperatorSession(ctx);
      const attachment=parts.length===8&&parts[5]==='attachments'&&parts[7]==='download';
      if(parts[1]!=='records'||parts[3]!=='revisions'||!(attachment||parts.length===6&&['read','download'].includes(parts[5])))
        documentScope.missing();
      let level;
      if(ctx.enabled)level=documentScope.authorize(state,ctx,parts[2],parts[4],attachment);
      else if(state.documentAccessScope!==undefined||!documents.view(rightsCaseScope.viewState(state,ctx),ctx.role).documents
        .some(doc=>doc.id===parts[2]&&doc.revisions.some(version=>version.id===parts[4])))
        documentScope.missing();
      if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Expected a JSON object.');
      const next=structuredClone(state);
      const commit=()=>{persist(next);state=next;};
      let result;
      try{
        result=documents.change(next,parts,ctx.role,body,(target,role,action,project,entity,details)=>{
          event(target,role,action,project,entity,details);target.audit.at(-1).account=ctx.account;
        });
      }catch(error){if(error.persistRefusal)commit();throw error;}
      if(ctx.enabled&&!attachment&&createHash('sha256').update(result.text).digest('hex')!==result.version.contentHash)
        throw Object.assign(Error('Document bytes do not match the approved edition.'),{status:409,code:'DOCUMENT_INTEGRITY'});
      commit();
      return level&&!attachment?{...result,version:documentScope.project(result.version,level)}:result;
    },
    getModules:()=>modules.model(state),
    caseOperatorState(ctx){
      requireCurrentOperatorSession(ctx);
      return rightsCaseScope.viewState(state,ctx);
    },
    getRights(ctx){
      if(ctx)requireCurrentOperatorSession(ctx);
      return projectRights(state,ctx);
    },
    getRightsIntake(ctx,generation=localSnapshotGeneration){
      requireCurrentOperatorSession(ctx);
      return readVersionedRights(state,ctx,generation);
    },
    createRightsIntake(ctx,body,{preferMinimal,clientVersion},generation=localSnapshotGeneration){
      requireCurrentOperatorSession(ctx);
      if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Expected a JSON object.');
      const before=intakeViewBasis(state,ctx),baseVersion=intakeVersion(generation,before);
      const next={...state,rightsCases:(state.rightsCases??[]).slice(),audit:state.audit.slice()};
      const row=rights.openStaffCase(next,ctx.role,body,(target,role,action,project,entity,details)=>{
        event(target,role,action,project,entity,details);
        target.audit.at(-1).account=ctx.account;
      });
      const after=intakeViewBasis(next,ctx);
      // The version check and persistence run under the same SQLite write
      // transaction (or synchronously with the single-process JSON store).
      const useDelta=baseVersion&&clientVersion===baseVersion&&before===after;
      let outcome;
      if(preferMinimal&&(clientVersion===undefined||useDelta)){
        const only=projectRights({...next,rightsCases:[row],audit:next.audit.slice(state.audit.length)},ctx);
        outcome={minimal:true,version:useDelta?intakeVersion(generation+1,after):null,
          model:{case:only.cases[0],delegation:only.delegation?.cases[0]??null,baseVersion:useDelta?baseVersion:null}};
      }else outcome=readVersionedRights(next,ctx,generation+1);
      persist(next);state=next;
      return outcome;
    },
    delegateRightsCase(id,ctx,body){
      requireCurrentOperatorSession(ctx);
      const next=structuredClone(state);
      rightsCaseScope.write(next,ctx,id,body,(target,actor,action,project,entity,details)=>{
        event(target,actor,action,project,entity,details);
        target.audit.at(-1).account=ctx.account;
      });
      persist(next);state=next;
      return projectRights(state,ctx);
    },
    changeRequesterIntakeForm(ctx,action,body){
      requireCurrentOperatorSession(ctx);
      const next=structuredClone(state);
      requesterIntakeForm.change(next,ctx,action,body,(target,actor,kind,project,id,details)=>{
        event(target,actor,kind,project,id,details);
        target.audit.at(-1).account=ctx.account;
      });
      persist(next);state=next;
      return projectRights(state,ctx);
    },
    getRightsDeadlinePolicy:account=>deadlines.view(state,account),
    getIncidents:(actor,account)=>incidents.view(state,actor,account),
    openAssessmentIncident(id,context,body){
      requireCurrentOperatorSession(context);
      const next=structuredClone(state);
      const result=assessmentIncident.open(next,context,id,body,(target,role,action,project,entity,details)=>{
        event(target,role,action,project,entity,details);
        target.audit.at(-1).account=context.account;
      });
      if(result.created){persist(next);state=next;}
      return result;
    },
    getDictionary:()=>dictionary.view(state),
    getProcessingRegister:()=>processingRegister.view(state),
    getProcessingExport:(id,version)=>processingRegister.approved(state,id,version),
    getDataMap:()=>dataMap.view(state),
    getLineage:id=>dataMap.lineage(state,id),
    getPreferences:()=>preferences.view(state),
    getRetention:()=>retention.view(state),
    getRiskControls:()=>riskControls.view(state),
    getAuditManagement:()=>auditManagement.view(state),
    getAssessmentConfiguration:()=>assessmentConfig.view(state),
    getAuditVerificationPackage:(id,scope)=>auditVerification.create(state,id,scope),
    getRemediationReport:id=>auditManagement.remediationReport(state,id),
    getAuditReport:id=>auditManagement.report(state,id),
    getMaturityPlanning:()=>maturityPlanning.view(state),
    getMaturityReport:(id,version)=>maturityPlanning.report(state,id,version),
    getVendorMonitoring:()=>vendorMonitoring.view(state),
    getProgramExport(prefix,field){
      return {[field]:programs.get(prefix).view(state),audit:state.audit.filter(e=>e.action.startsWith(prefix+'.'))};
    },
    visibleAudit:()=>state.audit.filter(e=>!excludedAudit(e)),
    listReportSchedules(caller){
      requireCurrentOperatorSession(caller);
      return reportSchedules.list(state,caller.actor,caller.account,Date.now(),reportWorkerEnabled);
    },
    changeReportSchedule(caller,action,body){
      requireCurrentOperatorSession(caller);
      const next={...state,audit:state.audit.slice(),reportScheduleBook:structuredClone(state.reportScheduleBook)};
      const result=reportSchedules.change(next,state.audit.filter(e=>!excludedAudit(e)),caller,action,body,event,{workerEnabled:reportWorkerEnabled});
      if(result.changed){persist(next);state=next;}
      return result.value;
    },
    runReportScheduleWorker(now){
      if(!storage||!reportWorkerEnabled)throw Error('Report worker is disabled for this workspace.');
      const next={...state,audit:state.audit.slice(),reportScheduleBook:structuredClone(state.reportScheduleBook)};
      const result=reportSchedules.runWorker(next,state.audit.filter(e=>!excludedAudit(e)),now,event);
      if(result.changed){persist(next);state=next;}
      return result;
    },
    listReportRuns:()=>reportRuns.list(state),
    readReportRun:(id,format)=>reportRuns.read(state,id,format),
    pinReportRun(body,mode,caller){
      if(caller)requireCurrentOperatorSession(caller);
      const next={...state};
      const bytes=reportRuns.create(next,state.audit.filter(e=>!excludedAudit(e)),body,mode);
      persist(next);state=next;
      return bytes;
    },
    reportSnapshot:()=>({state,audit:state.audit.filter(e=>!excludedAudit(e))}),
    change(parts,actor,body,account,generation,rightsContext,docReview) {
      if(generation!==undefined)requireCurrentOperatorSession({account,generation});
      if(rightsContext?.role==='case-operator')rightsCaseScope.verifyTarget(state,rightsContext,parts[2]);
      documentReviewSeats.enforce(state,parts,docReview);
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
        if(discoveryRuns.hasSavedRuns(state))fail(409,'Use the staged discovery rehearsal for this workspace.');
        try{result=discovery.apply(next,actor,body,event,discoveryScope(account));}
        catch(error){if(error.persistRefusal)commit();throw error;}
        if(!result.changed)return {result,map:dataMap.view(state)};
        commit();return {result,map:dataMap.view(state)};
      } else if(program){
        try{result=applyProgram(next,parts,actor,body,event,account);}
        catch(error){
          if(error.persistRefusal)commit();
          throw error;
        }
      } else if (parts[0]==='modules') {
        modules.change(next,parts,actor,body,event);
      } else if (parts.length===3 && parts[0]==='assessments') {
        try {actionAssessment(next,actor,find(next,'assessments',parts[1]),parts[2],body,account);}
        catch(error) {
          if(error.persistRefusal)commit();
          throw error;
        }
      } else if (parts.length===3&&parts[0]==='handoff') {
        actionHandoff(next,actor,find(next,'handoff',parts[1]),parts[2]);
      } else fail(404,'Endpoint not found.');
      if(docReview&&actor==='reviewer'&&parts.length===6&&['publish','return'].includes(parts[5]))
        documentReviewSeats.finish(next,parts[4]);
      commit();
      if(docReview?.limited&&result)return documentReviewSeats.textProjection(result);
      if(rightsContext&&!result)return projectRights(state,rightsContext);
      return result??(parts[0]==='modules'?modules.model(state):program===documents?documentModel(actor,account,docReview):
        program?program.view(state,actor,account):publicState());
    }
  };
  if(!storage)return operations;
  const mutations=new Set(['assignDocumentReviewer','directoryChange','changeDiscoveryRun','openAssessmentIncident','changeRequesterRelease','changeRightsRetrieval','changeRequesterIntakeForm','pinReportRun','createRightsIntake','changeReportSchedule','runReportScheduleWorker','delegateRightsCase','readCaseDocument','documentAccessTransition','changeOperatorJob','groupGovernanceChange','identityAdminChange','employeeAssign','employeeConfirm','trainingAdmin','trainingProgress','portalIntake','changeEthics','change']);
  return Object.fromEntries(Object.entries(operations).map(([name,fn])=>[name,(...args)=>{
    if(!mutations.has(name)){
      if(name==='getRightsIntake'){
        const {generation,payload}=storage.readSince(workbench,-1);
        state=payload??fresh();
        return fn(...args,generation);
      }
      if(name!=='identityMembership')state=storage.read(workbench)??fresh();
      return fn(...args);
    }
    let refusal;
    const result=storage.write(workbench,(snapshot,save,generation)=>{
      state=snapshot??fresh();
      saveSnapshot=save;
      try{return name==='createRightsIntake'?fn(...args,generation):fn(...args);}
      catch(error){
        // Domain refusals whose audit entries were explicitly saved still
        // commit. Other exceptions roll back the whole storage transaction.
        if(!error.persistRefusal)throw error;
        refusal=error;
      }finally{saveSnapshot=undefined;}
    });
    if(refusal)throw refusal;
    return result;
  }]));
}
module.exports={openStore};
