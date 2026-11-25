'use strict';
const {randomUUID}=require('node:crypto');
const assessmentFlow=require('./assessment-workflow');
const bookOf=s=>s.vendorMonitoring??{revision:0,cases:[]};
const policy={version:1,renewalDays:{low:365,moderate:180,high:90,critical:30}};
function fail(status,code,message){throw Object.assign(new Error(message),{status,code})}
function note(x,label,max=1000){
  if(typeof x!=='string'||!x.trim()||x.length>max)fail(422,'FIELD_REQUIRED',label+' is required and can contain up to '+max+' characters.');
  return x.trim();
}
function factor(x){
  if(!Number.isSafeInteger(x)||x<1||x>5)fail(422,'INVALID_FACTOR','Risk factors must be integers between 1 and 5.');
  return x;
}
function factors(body,vendor){
  const criticality=factor(body.criticality), exposure=factor(body.exposure);
  const ai=vendor.usesAI?2:0, sensitive=vendor.handlesSensitiveData?2:0;
  const score=criticality*exposure+ai+sensitive;
  const tier=score>=22?'critical':score>=14?'high':score>=7?'moderate':'low';
  return {criticality,exposure,ai,sensitive,score,tier,policyVersion:policy.version};
}
function dueDate(now,days){
  const d=new Date(now);
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
const current=c=>c.cycles.at(-1);
function associated(state,c,cycle){
  return state.assessments.filter(a=>a.vendorId===c.vendorId&&(a.monitoringCycleId??null)===cycle.assessmentCycleId);
}
function approvedAssessments(state,c,cycle){
  const vendor=state.vendors.find(v=>v.id===c.vendorId);
  const relevant=associated(state,c,cycle);
  const types=vendor.usesAI?['privacy','ai']:['privacy'];
  if(relevant.length!==types.length||!types.every(type=>relevant.some(a=>a.type===type&&assessmentFlow.isApproved(state,a))))
    fail(409,'ASSESSMENTS_NOT_APPROVED','Obtain independent approvals for all assessments in this review cycle.');
  return relevant.map(a=>({id:a.id,type:a.type,revision:a.revision,workflowInstanceId:a.workflowInstanceId,
    workflowRevision:a.workflowRevision,decisionBy:a.decisionBy}));
}
function view(state){
  const book=bookOf(state),today=new Date().toISOString().slice(0,10);
  return {...book,policy,vendors:state.vendors.map(({id,name,projectId,usesAI,handlesSensitiveData})=>({id,name,projectId,usesAI,handlesSensitiveData})),
    cases:book.cases.map(c=>({...c,assessmentStatus:associated(state,c,current(c)).map(a=>({id:a.id,type:a.type,status:a.status})),
      renewalState:c.status!=='monitoring'?'awaiting-review':c.renewalDueDate<=today?'due':'scheduled'})),
    legacyRecords:(state.moduleRecords??[]).filter(r=>r.moduleId==='third-party')};
}
const fields={
  create:['vendorId','criticality','exposure'], score:['criticality','exposure'], evidence:['reference','note'], submit:[],
  approve:['note'], return:['note'], change:['note','criticality','exposure'], renew:['note']
};
function change(state,parts,actor,body,event,startAssessments){
  const book=state.vendorMonitoring??=bookOf(state);
  const [,collection,id,step]=parts;
  const action=parts.length===2?'create':step;
  if(collection!=='cases'||!Object.hasOwn(fields,action)||!(parts.length===2||(parts.length===4&&action!=='create')))
    fail(404,'NOT_FOUND','Vendor monitoring action not found.');
  const existing=id?book.cases.find(c=>c.id===id):null;
  const audit=(kind,c,details)=>event(state,actor,'vendor-monitoring.'+kind,c?.projectId??null,c?.id??null,{...details,revision:book.revision});
  try {
    if(Object.keys(body).some(k=>!['expectedRevision',...fields[action]].includes(k)))fail(422,'UNKNOWN_FIELDS','Provide only the supported fields.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail(422,'REVISION_REQUIRED','Provide the current vendor monitoring revision.');
    if(body.expectedRevision!==book.revision)fail(409,'STALE_REVISION','Vendor monitoring changed. Reload before retrying.');
    const review=['approve','return'].includes(action),now=new Date().toISOString();
    if(action!=='create'&&!existing)fail(404,'RECORD_NOT_FOUND','Vendor monitoring case not found.');
    if(actor!==(review?'reviewer':'analyst')||review&&actor===existing.owner)fail(403,review?'INDEPENDENT_REVIEW_REQUIRED':'OWNER_REQUIRED',
      review?'A separate reviewer must decide.':'Only the assigned vendor analyst can take this action.');
    let c=existing,details;
    if(action==='create'){
      const vendor=state.vendors.find(v=>v.id===body.vendorId);
      if(!vendor)fail(404,'VENDOR_NOT_FOUND','Choose a vendor from the project intake.');
      if(book.cases.some(c=>c.vendorId===vendor.id))fail(409,'VENDOR_ALREADY_TRACKED','A monitoring case already exists for this vendor.');
      const cycle={number:1,assessmentCycleId:null,reason:'initial',factors:factors(body,vendor),evidence:[],assessmentSnapshot:[],review:null,openedAt:now};
      c={id:randomUUID(),vendorId:vendor.id,projectId:vendor.projectId,owner:actor,status:'collecting',openedAt:now,cycles:[cycle],renewalDueDate:null};
      book.cases.push(c);details={vendorId:c.vendorId,owner:c.owner,factors:cycle.factors};
    }else{
      const cycle=current(c);
      const vendor=state.vendors.find(v=>v.id===c.vendorId);
      function at(status){if(c.status!==status)fail(409,'OUT_OF_ORDER','This action is not available in this review stage.')}
      if(action==='score'){
        at('collecting');
        details={previous:cycle.factors,factors:factors(body,vendor)};
        cycle.factors=details.factors;
      }else if(action==='evidence'){
        at('collecting');
        if(typeof body.reference!=='string'||!/^SYN-[A-Z0-9]{3,24}$/.test(body.reference))fail(422,'INVALID_EVIDENCE','Use a fictional evidence ID such as SYN-VENDOR01.');
        if(cycle.evidence.some(e=>e.reference===body.reference))fail(409,'EVIDENCE_EXISTS','That reference already exists in this cycle.');
        details={reference:body.reference,note:note(body.note,'Fictional evidence note'),at:now};
        cycle.evidence.push(details);
      }else if(action==='submit'){
        at('collecting');
        if(!cycle.evidence.length)fail(422,'EVIDENCE_REQUIRED','Add a fictional due diligence reference.');
        if(cycle.review?.outcome==='returned'&&cycle.evidence.length<=cycle.review.evidenceCount)
          fail(409,'FRESH_EVIDENCE_REQUIRED','Record at least one additional evidence reference after the reviewer returned the cycle.');
        cycle.assessmentSnapshot=approvedAssessments(state,c,cycle);
        c.status='review';details={assessments:cycle.assessmentSnapshot,evidenceCount:cycle.evidence.length};
      }else if(review){
        at('review');
        const rationale=note(body.note,'Fictional review rationale');
        if(action==='approve'){
          const verified=approvedAssessments(state,c,cycle);
          if(JSON.stringify(verified)!==JSON.stringify(cycle.assessmentSnapshot))fail(409,'ASSESSMENT_CHANGED','The linked assessment decision changed. Return the cycle for rework.');
          c.status='monitoring';
          c.renewalDueDate=dueDate(now,policy.renewalDays[cycle.factors.tier]);
        }else c.status='collecting';
        cycle.review={outcome:action==='approve'?'approved':'returned',reviewedBy:actor,at:now,note:rationale,evidenceCount:cycle.evidence.length,
          renewalDueDate:c.renewalDueDate};
        details={...cycle.review};
      }else{
        at('monitoring');
        const rationale=note(body.note,'Fictional change or renewal rationale');
        const nextFactors=action==='change'?factors(body,vendor):{...cycle.factors};
        const cycleId=randomUUID();
        const assessmentIds=startAssessments(state,vendor,cycleId);
        c.cycles.push({number:cycle.number+1,assessmentCycleId:cycleId,reason:action,note:rationale,factors:nextFactors,evidence:[],assessmentSnapshot:[],
          review:null,openedAt:now});
        c.status='collecting';c.renewalDueDate=null;
        details={note:rationale,assessmentIds,previousCycle:cycle.number,factors:nextFactors};
      }
    }
    book.revision++;
    audit(action,c,{...details,cycle:current(c).number,status:c.status});
  }catch(e){
    if(!e.status)throw e;
    audit('refused',existing,{action,code:e.code,expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null});
    throw Object.assign(e,{persistRefusal:true});
  }
}
module.exports={view,change};
