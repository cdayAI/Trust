'use strict';
const rust=require('./rust-core');
const {randomUUID}=require('node:crypto');
const categories=['demo-customer','demo-employee','demo-operations'];
const triggerTypes=['created','closed'];
const dispositions=['delete','anonymize','archive'];
const bookOf=s=>s.retentionBook??{revision:0,schedules:[],records:[],holds:[],previews:[],runs:[]};

function issue(status,code,message){throw Object.assign(new Error(message),{status,code})}
function only(payload,keys){
  if(Object.keys(payload).some(k=>!keys.includes(k)))issue(422,'UNKNOWN_FIELDS','Provide only the supported fields.');
}
function choose(x,options,field){
  if(!options.includes(x))issue(422,'INVALID_CHOICE','Select a valid '+field+'.');
  return x;
}
function nonempty(x,field,max=1000){
  if(typeof x!=='string'||!x.trim()||x.length>max)issue(422,'FIELD_REQUIRED',field+' is required and must be at most '+max+' characters.');
  return x.trim();
}
function date(x,field){
  if(typeof x!=='string'||!/^(20[0-9]{2}|21[0-9]{2}|2200)-[0-9]{2}-[0-9]{2}$/.test(x))issue(422,'INVALID_DATE',field+' requires a valid UTC date from 2000 through 2200.');
  const d=new Date(x+'T00:00:00Z');
  if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==x)issue(422,'INVALID_DATE',field+' requires a valid UTC date.');
  return x;
}
const afterDays=(x,days)=>{
  if(rust.enabled)return rust.addDays(x,days,'calendar');
  const d=new Date(x+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
};
const find=(list,id,label)=>list.find(x=>x.id===id)??issue(404,'RECORD_NOT_FOUND',label+' not found.');
const activeSchedule=(b,category)=>b.schedules.findLast(s=>s.category===category&&s.status==='active');
function calculate(book,row,asOf){
  const schedule=activeSchedule(book,row.category);
  const holdIds=book.holds.filter(h=>h.recordId===row.id&&!h.releasedAt).map(h=>h.id);
  const triggeredOn=schedule?(schedule.trigger==='created'?row.createdOn:row.closedOn):null;
  const dueOn=triggeredOn?afterDays(triggeredOn,schedule.days):null;
  const reason=holdIds.length?'ACTIVE_HOLD':!schedule?'NO_ACTIVE_SCHEDULE':!triggeredOn?'TRIGGER_NOT_RECORDED':asOf<dueOn?'BEFORE_DUE_DATE':'ELIGIBLE';
  return {recordId:row.id,asOf,reason,eligible:reason==='ELIGIBLE',scheduleId:schedule?.id??null,
    scheduleVersion:schedule?.version??null,triggeredOn,dueOn,holdIds,disposition:schedule?.disposition??null,mode:'simulation-only'};
}
function view(state){
  const book=bookOf(state);
  const current=Object.fromEntries(categories.map(c=>[c,activeSchedule(book,c)?.id??null]));
  return {...book,categories,triggerTypes,dispositions,current,
    legacyRecords:(state.moduleRecords??[]).filter(r=>r.moduleId==='retention')};
}
// Evidence rehearsals use the same active-per-category selector as the
// retention workbench. Historical activated rules stay addressable for
// verification after a newer version becomes current.
function evidenceSchedules(state){
  const book=bookOf(state);
  return categories.map(category=>activeSchedule(book,category)).filter(Boolean);
}
function historicalEvidenceSchedule(state,id){
  const records=bookOf(state).schedules.filter(row=>row.id===id&&row.status==='active');
  return records.length===1&&categories.includes(records[0].category)?records[0]:undefined;
}
function scheduleFields(body){
  if(!Number.isSafeInteger(body.days)||body.days<1||body.days>36500)issue(422,'INVALID_PERIOD','Enter 1–36,500 calendar days.');
  return {title:nonempty(body.title,'Schedule title',120),trigger:choose(body.trigger,triggerTypes,'trigger'),
    days:body.days,disposition:choose(body.disposition,dispositions,'disposition')};
}
const routes={
  schedules:{create:['category','title','trigger','days','disposition'],edit:['title','trigger','days','disposition'],submit:[],activate:['note'],return:['note']},
  records:{create:['reference','category','createdOn','closedOn']},
  holds:{create:['recordId','note'],release:['note']},
  previews:{create:['recordId','asOf'],simulate:[]}
};
function change(state,parts,actor,body,event){
  const book=state.retentionBook??=bookOf(state);
  const [,collection,id,rawAction]=parts;
  const action=parts.length===2?'create':rawAction;
  if(!Object.hasOwn(routes,collection)||!Object.hasOwn(routes[collection],action)||
    !(parts.length===2||(parts.length===4&&action!=='create')))issue(404,'NOT_FOUND','Retention action not found.');
  function record(kind,x,details){event(state,actor,'retention.'+kind,null,x,{...details,revision:book.revision});}
  try{
    only(body,['expectedRevision',...routes[collection][action]]);
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)issue(422,'REVISION_REQUIRED','Provide the current retention revision.');
    if(body.expectedRevision!==book.revision)issue(409,'STALE_REVISION','Retention changed. Reload before retrying.');
    const reviewer=(collection==='schedules'&&['activate','return'].includes(action))||(collection==='holds'&&action==='release');
    if(actor!==(reviewer?'reviewer':'analyst'))issue(403,reviewer?'INDEPENDENT_REVIEW_REQUIRED':'ANALYST_REQUIRED',reviewer?
      'A separate reviewer must record this decision.':'Only the retention analyst can take this action.');
    const now=new Date().toISOString();
    let row,details;
    if(collection==='schedules'){
      if(action==='create'){
        const category=choose(body.category,categories,'category');
        const prior=book.schedules.filter(s=>s.category===category);
        if(prior.some(s=>s.status!=='active'))issue(409,'DRAFT_EXISTS','An unfinished revision already exists in this category.');
        row={id:randomUUID(),category,version:(prior.at(-1)?.version??0)+1,...scheduleFields(body),
          status:'draft',authoredBy:actor,createdAt:now,activatedAt:null,activatedBy:null,reviewNote:null};
        book.schedules.push(row);
      }else{
        row=find(book.schedules,id,'Schedule');
        if(row.status==='active')issue(409,'SCHEDULE_IMMUTABLE','Activated revisions cannot be changed.');
        const expected=['edit','submit'].includes(action)?'draft':'review';
        if(row.status!==expected)issue(409,'OUT_OF_ORDER','This action is not available at the current stage.');
        if(action==='edit')Object.assign(row,scheduleFields(body));
        else if(action==='submit'){row.status='review';row.reviewNote=null}
        else {
          if(row.authoredBy===actor)issue(403,'INDEPENDENT_REVIEW_REQUIRED','The author cannot activate this revision.');
          row.reviewNote=nonempty(body.note,'Review note');
          if(action==='return')row.status='draft';
          else {row.status='active';row.activatedAt=now;row.activatedBy=actor}
        }
      }
      details={...row};
    }else if(collection==='records'){
      if(typeof body.reference!=='string'||!/^SYN-[A-Z0-9]{3,24}$/.test(body.reference))issue(422,'INVALID_REFERENCE','Use a fixture identifier such as SYN-RECORD01.');
      if(book.records.some(r=>r.reference===body.reference))issue(409,'DUPLICATE_REFERENCE','A fixture already uses that ID.');
      const createdOn=date(body.createdOn,'Created date');
      const closedOn=body.closedOn===undefined||body.closedOn===''?null:date(body.closedOn,'Closed date');
      if(closedOn&&closedOn<createdOn)issue(422,'BAD_ORDER','The closed date cannot precede creation.');
      row={id:randomUUID(),reference:body.reference,category:choose(body.category,categories,'category'),createdOn,closedOn,addedAt:now};
      book.records.push(row);details={...row};
    }else if(collection==='holds'){
      const note=nonempty(body.note,'Fictional hold rationale');
      if(action==='create'){
        const linked=find(book.records,body.recordId,'Fictional record');
        row={id:randomUUID(),recordId:linked.id,note,placedBy:actor,placedAt:now,releasedAt:null,releasedBy:null,releaseNote:null};
        book.holds.push(row);
      }else{
        row=find(book.holds,id,'Hold');
        if(row.releasedAt)issue(409,'HOLD_ALREADY_RELEASED','This hold has already been released.');
        Object.assign(row,{releasedAt:now,releasedBy:actor,releaseNote:note});
      }
      details={...row};
    }else if(action==='create'){
      const linked=find(book.records,body.recordId,'Fictional record');
      row={id:randomUUID(),...calculate(book,linked,date(body.asOf,'Simulation date')),createdAt:now,createdBy:actor};
      book.previews.push(row);details={...row};
    }else{
      const preview=find(book.previews,id,'Disposition preview');
      if(!preview.eligible)issue(409,'PREVIEW_NOT_ELIGIBLE','Only an eligible preview can be simulated.');
      if(book.runs.some(r=>r.previewId===id))issue(409,'ALREADY_SIMULATED','This preview already has a simulation result.');
      const linked=find(book.records,preview.recordId,'Fictional record');
      const live=calculate(book,linked,preview.asOf);
      if(live.reason==='ACTIVE_HOLD')issue(409,'ACTIVE_HOLD','An active hold blocks this simulation.');
      if(!live.eligible||live.scheduleId!==preview.scheduleId)issue(409,'PREVIEW_OUTDATED','The schedule changed. Create a new preview.');
      if(book.runs.some(r=>r.recordId===preview.recordId&&r.scheduleId===preview.scheduleId))issue(409,'ALREADY_SIMULATED','This fixture and schedule version already have a simulation result.');
      row={id:randomUUID(),previewId:id,recordId:linked.id,scheduleId:live.scheduleId,scheduleVersion:live.scheduleVersion,
        disposition:live.disposition,simulatedAt:now,simulatedBy:actor,mode:'audit-only',changedRecord:false,deleted:false};
      book.runs.push(row);details={...row};
    }
    book.revision++;
    record(collection+'.'+action,row.id,details);
  }catch(e){
    if(!e.status)throw e;
    record('refused',id??null,{collection,action,code:e.code});
    throw Object.assign(e,{persistRefusal:true});
  }
}
module.exports={view,change,evidenceSchedules,historicalEvidenceSchedule,evidenceDate:value=>date(value,'Evidence rehearsal date'),afterDays};
