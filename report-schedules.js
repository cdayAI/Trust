'use strict';
const {randomUUID}=require('node:crypto');
const reportRuns=require('./reporting-runs');
const route=/^\/api\/reporting\/schedules(?:\/(create|approve|stop|tick))?$/u;
const id=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const day=86400000, minute=60000;
const intervals=Object.freeze({daily:day,weekly:7*day});
const limits=Object.freeze({maxPlans:8,maxReceiptsPerPlan:24,maxAheadDays:366});
const iso=at=>new Date(at).toISOString();
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const invalid=message=>fail(422,'INVALID_REPORT_SCHEDULE',message);
const bookOf=state=>state.reportScheduleBook??{revision:0,plans:[]};
function shape(body,keys){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length||!keys.every(key=>Object.hasOwn(body,key)))
    invalid('Submit only the fields for this schedule action.');
}
function utc(value,label,minuteOnly=false){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value))invalid(label+' must be a UTC timestamp.');
  const at=Date.parse(value);
  if(!Number.isSafeInteger(at)||iso(at)!==value||at<Date.UTC(2020,0,1)||at>=Date.UTC(2200,0,1)||minuteOnly&&at%minute!==0)
    invalid(label+' must be a valid UTC time'+(minuteOnly?' at a whole minute.':'.'));
  return at;
}
function lookup(book,planId){
  if(typeof planId!=='string'||!id.test(planId))invalid('Choose a report schedule.');
  const plan=book.plans.find(row=>row.id===planId);
  if(!plan)fail(404,'REPORT_SCHEDULE_NOT_FOUND','That schedule is not in this workspace.');
  return plan;
}
function list(state,role,account,now=Date.now()){
  const stored=bookOf(state),pins=reportRuns.list(state,now).runs,current=stored.plans.at(-1);
  const active=new Set(pins.map(x=>x.id)),canCreate=role==='analyst'&&(!current||current.status==='stopped')&&stored.plans.length<limits.maxPlans;
  return {mode:'explicit-synthetic-tick',limits,cadences:Object.keys(intervals),revision:stored.revision,canCreate,
    templates:canCreate?pins.map(({id,generatedAt,filters})=>({id,generatedAt,filters})):[],
    plans:stored.plans.slice().reverse().map(({authorAccount,approvedAccount,receipts,...row})=>({...row,
      canApprove:role==='reviewer'&&row.status==='draft'&&!!account&&account!==authorAccount,
      canStop:role==='reviewer'&&row.status!=='stopped',
      dueNow:row.status==='active'&&Date.parse(row.nextDueAt)<=now,
      receipts:receipts.slice().reverse().map(receipt=>({...receipt,available:active.has(receipt.reportId)}))
    }))};
}
function change(state,audit,caller,action,body,event,{now=Date.now()}={}){
  const {actor,account}=caller;
  if(!account||!['analyst','reviewer'].includes(actor))fail(403,'REPORT_SCHEDULE_ROLE','Sign in as an analyst or reviewer.');
  const book=bookOf(state),at=iso(now);
  const model=(changed,outcome,receipt=null)=>({changed,value:{...list(state,actor,account,now),outcome,receipt}});
  function commit(plan,outcome,details={},receipt){
    book.revision++;
    state.reportScheduleBook=book;
    event(state,actor,'reporting.schedule.'+outcome,null,plan.id,details);
    state.audit.at(-1).account=account;
    return model(true,outcome,receipt);
  }
  function revision(){
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)invalid('Provide the latest report schedule revision.');
    if(body.expectedRevision!==book.revision)fail(409,'STALE_REPORT_SCHEDULE','This schedule changed. Reload it before retrying.');
  }
  if(action==='create'){
    if(actor!=='analyst')fail(403,'REPORT_SCHEDULE_AUTHOR','Only an analyst can propose a report schedule.');
    shape(body,['expectedRevision','sourceRunId','cadence','firstDueAt']);revision();
    if(book.plans.some(row=>row.status!=='stopped'))fail(409,'ACTIVE_REPORT_SCHEDULE','Finish or stop the current report schedule before proposing another.');
    if(book.plans.length>=limits.maxPlans)fail(409,'REPORT_SCHEDULE_LIMIT','This workspace reached its local report schedule limit.');
    if(typeof body.sourceRunId!=='string'||!id.test(body.sourceRunId))invalid('Choose an available pinned report.');
    const source=reportRuns.list(state,now).runs.find(row=>row.id===body.sourceRunId);
    if(!source)fail(404,'REPORT_RUN_NOT_FOUND','That pinned report is no longer available here.');
    if(typeof body.cadence!=='string'||!Object.hasOwn(intervals,body.cadence))invalid('Choose daily or weekly cadence.');
    const first=utc(body.firstDueAt,'First due time',true);
    if(first<Math.floor(now/minute)*minute||first>now+limits.maxAheadDays*day)invalid('First due time must be within the next 366 days (UTC).');
    const plan={id:randomUUID(),status:'draft',sourceRunId:source.id,filters:{...source.filters},cadence:body.cadence,
      firstDueAt:iso(first),nextDueAt:iso(first),createdAt:at,approvedAt:null,stoppedAt:null,authorAccount:account,approvedAccount:null,receipts:[]};
    book.plans.push(plan);
    return commit(plan,'proposed',{sourceRunId:source.id,cadence:plan.cadence,firstDueAt:plan.firstDueAt});
  }
  if(action==='approve'||action==='stop'){
    if(actor!=='reviewer')fail(403,'REPORT_SCHEDULE_REVIEWER','Only a reviewer can approve or stop a schedule.');
    shape(body,['expectedRevision','planId']);revision();
    const plan=lookup(book,body.planId);
    if(action==='approve'){
      if(plan.authorAccount===account)fail(403,'REPORT_SCHEDULE_INDEPENDENT_REVIEW','The schedule author cannot independently approve it.');
      if(plan.status!=='draft')fail(409,'REPORT_SCHEDULE_WRONG_STATUS','Only a draft schedule can be approved.');
      plan.status='active';plan.approvedAccount=account;plan.approvedAt=at;
      return commit(plan,'approved',{firstDueAt:plan.firstDueAt,nextDueAt:plan.nextDueAt});
    }
    if(plan.status==='stopped')fail(409,'REPORT_SCHEDULE_WRONG_STATUS','This schedule is already stopped.');
    plan.status='stopped';plan.stoppedAt=at;
    return commit(plan,'stopped',{nextDueAt:plan.nextDueAt});
  }
  if(action!=='tick')fail(404,'REPORT_SCHEDULE_NOT_FOUND','That schedule action is not available.');
  shape(body,['planId','slotAt','simulatedAt']);
  const plan=lookup(book,body.planId),slot=utc(body.slotAt,'Slot time',true),simulated=utc(body.simulatedAt,'Simulated time');
  const first=Date.parse(plan.firstDueAt),nextDue=Date.parse(plan.nextDueAt),interval=intervals[plan.cadence];
  if(!Number.isSafeInteger(interval)||!Number.isSafeInteger(first)||!Number.isSafeInteger(nextDue)||nextDue<first||(nextDue-first)%interval!==0)
    fail(409,'REPORT_SCHEDULE_INCONSISTENT','The saved schedule cursor is not consistent.');
  if(slot<first||(slot-first)%interval!==0)invalid('Use a slot on the approved UTC cadence.');
  if(simulated>now+limits.maxAheadDays*day)invalid('Simulated time cannot be more than 366 days ahead.');
  // An exact repeated slot stays idempotent even after recent receipts or pins
  // expire, and after stopping the plan. No retry can run another slot.
  if(slot<nextDue)return model(false,'already-run',plan.receipts.find(row=>row.slotAt===body.slotAt)??null);
  if(plan.status!=='active'||!plan.approvedAccount||plan.approvedAccount===plan.authorAccount)
    fail(409,'REPORT_SCHEDULE_NOT_APPROVED','Only an independently approved active schedule may run.');
  if(slot>nextDue)fail(409,'REPORT_SCHEDULE_SLOT_OUT_OF_ORDER','Only the next unprocessed slot may run.');
  if(simulated<slot)return model(false,'not-due');
  // Capture now, with existing immutable saved-report rules. Simulated time is
  // only a due check; importing or replaying old workspace states is not possible.
  const captured=JSON.parse(reportRuns.create(state,audit,{filters:plan.filters},'local-isolated',{now}).toString('utf8'));
  const receipt={slotAt:body.slotAt,simulatedAt:body.simulatedAt,capturedAt:captured.generatedAt,reportId:captured.run.id,total:captured.counts.total};
  plan.receipts.push(receipt);
  if(plan.receipts.length>limits.maxReceiptsPerPlan)plan.receipts.shift();
  plan.nextDueAt=iso(slot+interval);
  return commit(plan,'ran',{slotAt:receipt.slotAt,reportId:receipt.reportId,nextDueAt:plan.nextDueAt},receipt);
}
module.exports={route,list,change};
