'use strict';
const {createHash}=require('node:crypto');
const severities=Object.freeze(['low','moderate','high','critical']);
const scopeClasses=Object.freeze(['limited','broad','unknown']);
const branches=Object.freeze(['standard','elevated']);
const bounds=Object.freeze({reviewHours:168,noticeHours:720,versions:32});
const hour=60*60*1000;
const defaults={
  title:'Fictional incident routing',
  routes:severities.flatMap(severity=>scopeClasses.map(scopeClass=>{
    const elevated=severity==='high'||severity==='critical'||scopeClass==='broad';
    return {severity,scopeClass,branch:elevated?'elevated':'standard',reviewHours:elevated?8:24,noticeHours:elevated?24:72};
  }))
};
function issue(status,code,message){throw Object.assign(new Error(message),{status,code});}
const invalid=message=>issue(422,'INVALID_INCIDENT_POLICY',message);
function keys(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))
    invalid('Incident policy contains unsupported or malformed fields.');
}
function text(value,max,label){
  if(typeof value!=='string'||value.length>max||!value.trim())invalid(label+' requires 1 to '+max+' characters.');
  return value.trim();
}
function compile(input){
  keys(input,['title','routes']);
  const title=text(input.title,120,'Policy title');
  if(!Array.isArray(input.routes)||input.routes.length!==severities.length*scopeClasses.length)
    invalid('Provide exactly one route for each severity and scope classification.');
  const routes=new Map();
  for(const entry of input.routes){
    keys(entry,['severity','scopeClass','branch','reviewHours','noticeHours']);
    const {severity,scopeClass,branch,reviewHours,noticeHours}=entry;
    if(!severities.includes(severity)||!scopeClasses.includes(scopeClass)||!branches.includes(branch))invalid('Choose a supported severity, scope and investigation branch.');
    if(['high','critical'].includes(severity)&&branch!=='elevated')invalid('High and critical severity always require elevated investigation.');
    for(const [window,value] of [['reviewHours',reviewHours],['noticeHours',noticeHours]]){
      if(!Number.isSafeInteger(value)||value<1||value>bounds[window])invalid(window+' must be a whole number from 1 to '+bounds[window]+'.');
    }
    const key=severity+'/'+scopeClass;
    if(routes.has(key))invalid('Duplicate severity and scope combination: '+key+'.');
    routes.set(key,{severity,scopeClass,branch,reviewHours,noticeHours});
  }
  return {title,routes:severities.flatMap(severity=>scopeClasses.map(scope=>routes.get(severity+'/'+scope)))};
}
const digest=def=>createHash('sha256').update(JSON.stringify(compile(def))).digest('hex');
const blank=()=>({revision:0,releases:[]});
const bookOf=state=>state.incidentPolicyBook??blank();
const releaseOf=(book,version)=>book.releases.find(item=>item.version===version);
const published=book=>book.releases.findLast(item=>item.status==='published');
function verified(release){
  try{
    if(release?.status==='published'&&release.hash===digest(release.definition))return release;
  }catch{}
  issue(409,'INCIDENT_POLICY_INCONSISTENT','The pinned incident policy failed its integrity check.');
}
function view(state,actor,account){
  const book=bookOf(state),active=published(book);
  return {mode:'simulation-only',revision:book.revision,activeVersion:active?.version??null,scopeClasses,severities,bounds,
    releases:book.releases.map(({authorAccount,reviewerAccount,...release})=>({...release,
      canEdit:release.status==='draft'&&actor===release.author&&(!authorAccount||authorAccount===account),
      canReview:release.status==='review'&&actor==='reviewer'&&actor!==release.author&&(!authorAccount||authorAccount!==account)
    }))};
}
function change(state,parts,actor,body,event,account,now){
  if(parts.length!==3||parts[1]!=='policy'||!['create','edit','submit','return','publish'].includes(parts[2]))
    issue(404,'NOT_FOUND','Incident policy action was not found.');
  const action=parts[2],reviewing=['return','publish'].includes(action);
  if(actor!==(reviewing?'reviewer':'analyst'))
    issue(403,reviewing?'INDEPENDENT_REVIEW_REQUIRED':'POLICY_AUTHOR_REQUIRED',
      reviewing?'A separate reviewer controls incident policy publication.':'Only an incident analyst can draft and submit policies.');
  keys(body,['expectedRevision',...(action==='edit'?['definition']:reviewing?['note']:[])]);
  const book=bookOf(state);
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)invalid('Provide the current incident policy revision.');
  if(body.expectedRevision!==book.revision)issue(409,'STALE_REVISION','This incident policy changed. Reload before retrying.');
  const latest=book.releases.at(-1);
  let row=latest;
  if(action==='create'){
    if(latest?.status==='draft'||latest?.status==='review')issue(409,'ACTIVE_POLICY_DRAFT','Finish the current incident policy draft before creating another.');
    if(book.releases.length>=bounds.versions)issue(409,'POLICY_VERSION_LIMIT','This workspace is at the incident policy version limit.');
    const prior=published(book);
    if(prior)verified(prior);
    row={version:(latest?.version??0)+1,status:'draft',definition:structuredClone(prior?.definition??defaults),author:actor,
      authorAccount:account??null,hash:null,createdAt:now,updatedAt:now,submittedAt:null,publishedAt:null,review:null};
    book.releases.push(row);
  }else{
    if(!row)issue(404,'NOT_FOUND','Create an incident policy draft first.');
    if(!reviewing&&(row.author!==actor||(row.authorAccount&&row.authorAccount!==account)))
      issue(403,'POLICY_AUTHOR_REQUIRED','Only this policy version’s author may edit and submit it.');
    if(reviewing&&(row.author===actor||(row.authorAccount&&row.authorAccount===account)))
      issue(403,'INDEPENDENT_REVIEW_REQUIRED','The policy author cannot act as the independent reviewer.');
    if(row.status!==(reviewing?'review':'draft'))issue(409,'INVALID_TRANSITION','The incident policy is not at the required stage.');
    if(action==='edit')row.definition=compile(body.definition);
    else if(action==='submit'){
      row.definition=compile(row.definition);row.status='review';row.submittedAt=now;
    }else{
      row.review={decision:action,by:actor,at:now,note:text(body.note,500,'Fictional review rationale')};
      row.reviewerAccount=account??null;
      if(action==='return')row.status='draft';
      else{
        row.definition=compile(row.definition);
        row.hash=digest(row.definition);row.status='published';row.publishedAt=now;
      }
    }
  }
  row.updatedAt=now;
  book.revision++;
  state.incidentPolicyBook=book;
  event(state,actor,'incident.policy.'+action,null,'incident-policy:'+row.version,
    {version:row.version,status:row.status,sha256:row.hash,revision:book.revision,...(reviewing?{note:row.review.note}:{})});
  return;
}
function pin(state){
  const current=published(bookOf(state));
  if(!current)return null;
  const release=verified(current);
  return {version:release.version,sha256:release.hash};
}
function route(state,pinned,scopeClass,severity){
  if(!pinned)return null;
  const release=verified(releaseOf(bookOf(state),pinned.version));
  if(pinned.sha256!==release.hash)issue(409,'INCIDENT_POLICY_INCONSISTENT','The case is not bound to this incident policy.');
  if(!scopeClasses.includes(scopeClass)||!severities.includes(severity))issue(409,'INCIDENT_POLICY_INCONSISTENT','The case or scope classification is invalid.');
  const definition=compile(release.definition);
  const selected=definition.routes.find(item=>item.severity===severity&&item.scopeClass===scopeClass);
  return {...selected,policyTitle:definition.title};
}
function deadline(at,hours){
  return new Date(Date.parse(at)+hours*hour).toISOString();
}
function status(dueAt,completedAt,at=new Date().toISOString()){
  if(!dueAt)return null;
  if(completedAt)return completedAt<=dueAt?'completed-on-time':'completed-late';
  return at>dueAt?'overdue':'pending';
}
function windows(row,at){
  if(!row.policyPin||!row.policyRoute)return null;
  return {
    reviewHours:row.policyRoute.reviewHours,noticeHours:row.policyRoute.noticeHours,
    reviewDueAt:row.reviewDueAt??null,noticeDueAt:row.noticeDueAt??null,
    reviewStatus:status(row.reviewDueAt,row.stage!=='review'&&row.review?.dueAt===row.reviewDueAt?row.review?.at:null,at),
    noticeStatus:status(row.noticeDueAt,row.noticePlan?.at,at)
  };
}
function taskDate(row){
  const at=row.stage==='review'?row.reviewDueAt:row.stage==='notice-planning'?row.noticeDueAt:null;
  return typeof at==='string'&&/^\d{4}-\d\d-\d\dT/u.test(at)?at.slice(0,10):null;
}
module.exports={view,change,pin,route,deadline,status,windows,taskDate,severities,scopeClasses};
