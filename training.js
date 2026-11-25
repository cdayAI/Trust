'use strict';
const {createHash,createHmac,randomUUID}=require('node:crypto');
const {policyEdition,listPolicyEditions}=require('./governance-documents');

const attemptsPerCycle=5;
const quiz={
  id:'fictional-policy-practice-v1',title:'Practicing a policy review',
  lesson:'Use the assigned published policy. In this exercise, record a fictional concern through the approved process, keep protected details within approved channels, and ask for review if the policy is unclear.',
  questions:[
    {prompt:'Which document should you consult for this exercise?',choices:['An unsigned draft','The assigned published policy edition','An unrelated example'],correct:1},
    {prompt:'How should you report a fictional concern?',choices:['Use the approved process','Post it publicly','Forward it to a personal inbox'],correct:0},
    {prompt:'What should you do when the assigned policy is unclear?',choices:['Ignore the policy','Share the scenario with outside contacts','Ask for review through the approved channels'],correct:2}
  ]
};
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const hash=/^[a-f0-9]{64}$/u;
const codePattern=/^[A-Za-z0-9_-]{43}$/u;
const learnerAlias=/^sample-learner-[a-z0-9-]{1,32}$/u;
const digest=x=>createHash('sha256').update(x).digest('hex');
const clock=()=>new Date().toISOString();
const quizHash=digest(JSON.stringify(quiz));
const model=state=>state.training??{courses:[],assignments:[]};
const canReset=row=>row.status==='retry-required'&&!row.resetCount;
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const validId=x=>typeof x==='string'&&uuid.test(x);
function only(body,keys){
  if(!isObject(body)||Object.keys(body).length!==keys.length||!keys.every(k=>Object.hasOwn(body,k)))
    fail(422,'TRAINING_FIELDS','Send only the required training fields.');
}
function label(value,name,max){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))
    fail(422,'TRAINING_FIELD_INVALID',name+' must be a single line from 1 to '+max+' characters.');
  return value.trim();
}
function provision({grants,key,workspaces,accounts,requesters=[],employees=[],now=Date.now}){
  if(!Array.isArray(grants)||!grants.length||grants.length>64||typeof key!=='string'||!hash.test(key)||typeof now!=='function')
    throw new Error('Invalid synthetic training provisioning.');
  const spaces=new Set(workspaces.map(x=>x.id)), aliases=new Set(),index=new Map(),teams=new Map();
  const used=new Set([...accounts,...requesters,...employees].map(x=>x.codeHash));
  for(const {alias,workspace,codeHash,expiresAt} of grants){
    if(typeof alias!=='string'||!learnerAlias.test(alias)||aliases.has(alias)||!spaces.has(workspace)||
      typeof codeHash!=='string'||!hash.test(codeHash)||used.has(codeHash)||!integer(expiresAt,1,now()+604800000))
      throw new Error('Invalid synthetic training learner.');
    aliases.add(alias);used.add(codeHash);
    const learner={alias,workspace,expiresAt};
    index.set(codeHash,learner);
    if(!teams.has(workspace))teams.set(workspace,[]);
    teams.get(workspace).push(learner);
  }
  let failed=0,windowEnd=0;
  return {
    enabled:workspace=>teams.has(workspace),
    learners:workspace=>(teams.get(workspace)??[]).filter(x=>x.expiresAt>now()).map(x=>x.alias),
    sign:payload=>createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(payload)).digest('hex'),
    authenticate(body){
      const time=now();
      if(time>=windowEnd){windowEnd=time+60000;failed=0;}
      const candidate=typeof body?.code==='string'&&codePattern.test(body.code)?index.get(digest(body.code)):null;
      if(!candidate||candidate.expiresAt<=time){
        if(++failed>30)fail(429,'TRAINING_WAIT','Wait a minute before retrying a test code.');
        fail(401,'LEARNER_ACCESS_REQUIRED','A valid local synthetic learner code is required.');
      }
      return candidate;
    }
  };
}
function policy(state,document,edition,sha){
  const active=validId(document)&&validId(edition)?policyEdition(state,document,edition):null;
  if(!active)fail(404,'TRAINING_POLICY_MISSING','Choose a published policy edition in this workspace.');
  if(active.hash!==sha)fail(409,'TRAINING_POLICY_MISMATCH','The policy digest differs; reload the published policy.');
  const {number,title,hash}=active;
  return {reference:{document,edition,number,title,hash},text:active.text};
}
function operatorView(state,learners){
  const {courses,assignments}=model(state);
  return {enabled:true,learners,editions:listPolicyEditions(state),templates:[{id:quiz.id,title:quiz.title,questions:quiz.questions.length,passing:quiz.questions.length}],
    courses,assignments};
}
const adminFields={
  create:['title','document','edition','hash','template'],edit:['course','revision','title','document','edition','hash','template'],
  submit:['course','revision'],return:['course','revision','note'],publish:['course','revision','note'],
  assign:['course','revision','learner'],reset:['assignment','revision']
};
function admin(state,learners,actor,account,action,body,event){
  const revisionAudit=(kind,id,details)=>event(state,actor,'training.'+kind,null,id,{account,...details});
  try{
    const isReview=['return','publish'].includes(action);
    if(actor!==(isReview?'reviewer':'analyst'))fail(403,'TRAINING_ROLE_REQUIRED','Use the designated author or independent reviewer role.');
    if(!Object.hasOwn(adminFields,action))fail(404,'TRAINING_ACTION_MISSING','Training action not found.');
    only(body,adminFields[action]);
    const board=model(state);
    if(action==='reset'){
      const row=validId(body.assignment)?board.assignments.find(a=>a.id===body.assignment):null;
      if(!row)fail(404,'TRAINING_ASSIGNMENT_MISSING','The training assignment was not found.');
      if(row.revision!==body.revision)fail(409,'TRAINING_STALE','The assignment changed. Reload before retrying.');
      if(!canReset(row))fail(409,'TRAINING_RESET_UNAVAILABLE','Only a first exhausted assignment can be reset.');
      row.status='in-progress';row.cycleAttempts=0;row.resetCount=1;row.revision++;
      revisionAudit('assignment-reset',row.id,{course:row.course,revision:row.revision});
      return true;
    }
    let course=validId(body.course)?board.courses.find(c=>c.id===body.course):null;
    const now=clock();
    if(action==='create'||action==='edit'){
      if(action==='create'&&board.courses.length>=100)fail(409,'TRAINING_COURSE_LIMIT','This workspace has reached its synthetic course limit.');
      if(action==='edit'){
        if(!course)fail(404,'TRAINING_COURSE_MISSING','The course was not found.');
        if(course.revision!==body.revision)fail(409,'TRAINING_STALE','The course changed. Reload before retrying.');
        if(course.status!=='draft')fail(409,'TRAINING_COURSE_LOCKED','Only a draft course can be edited.');
      }
      const title=label(body.title,'Course title',120);
      if(body.template!==quiz.id)fail(422,'TRAINING_TEMPLATE_INVALID','Choose the bundled course exercise.');
      const selected=policy(state,body.document,body.edition,body.hash);
      if(action==='create'){
        course={id:randomUUID(),author:account,revision:1,status:'draft',title,policy:selected.reference,template:quiz.id,templateHash:quizHash,
          createdAt:now,updatedAt:now,review:null};
        (state.training??=board).courses.push(course);
      }else{
        Object.assign(course,{title,policy:selected.reference,template:quiz.id,templateHash:quizHash,updatedAt:now});course.revision++;
      }
      revisionAudit(action,course.id,{edition:course.policy.edition,revision:course.revision});
      return true;
    }
    if(!course)fail(404,'TRAINING_COURSE_MISSING','The course was not found.');
    if(course.revision!==body.revision)fail(409,'TRAINING_STALE','The course changed. Reload before retrying.');
    if(action==='assign'){
      if(course.status!=='published')fail(409,'TRAINING_COURSE_UNPUBLISHED','Publish this course before assigning it.');
      if(!learners.includes(body.learner))fail(404,'TRAINING_LEARNER_MISSING','Choose a provisioned learner in this workspace.');
      if(board.assignments.some(x=>x.course===course.id&&x.learner===body.learner))return false;
      if(board.assignments.length>=500)fail(409,'TRAINING_ASSIGNMENT_LIMIT','This workspace has reached its synthetic assignment limit.');
      policy(state,course.policy.document,course.policy.edition,course.policy.hash);
      const row={id:randomUUID(),course:course.id,courseRevision:course.revision,learner:body.learner,status:'assigned',
        revision:1,assignedAt:now,startedAt:null,receipt:null,cycleAttempts:0,attempts:0,lastScore:null,resetCount:0};
      board.assignments.push(row);
      revisionAudit('assigned',row.id,{course:course.id,courseRevision:course.revision});
      return true;
    }
    if(action==='submit'){
      if(course.status!=='draft')fail(409,'TRAINING_COURSE_LOCKED','Only a draft may be submitted.');
      policy(state,course.policy.document,course.policy.edition,course.policy.hash);
      course.status='review';course.review=null;
    }else{
      if(course.status!=='review')fail(409,'TRAINING_REVIEW_REQUIRED','Submit the draft before an independent review.');
      if(course.author===account)fail(403,'TRAINING_SELF_REVIEW','The author cannot review their own course.');
      const note=label(body.note,'Review note',500);
      policy(state,course.policy.document,course.policy.edition,course.policy.hash);
      course.review={note,reviewedBy:account,reviewedAt:now};
      course.status=action==='publish'?'published':'draft';
      if(action==='publish')course.publishedAt=now;
    }
    course.revision++;course.updatedAt=now;
    revisionAudit(action,course.id,{edition:course.policy.edition,revision:course.revision});
    return true;
  }catch(error){
    if(error.status){
      revisionAudit('refused',null,{operation:action,code:error.code});
      error.persistRefusal=true;
    }
    throw error;
  }
}
function ownAssignment(state,seat,id){
  const {courses,assignments}=model(state);
  const row=validId(id)?assignments.find(x=>x.id===id&&x.learner===seat.alias):null;
  if(!row)fail(404,'TRAINING_ASSIGNMENT_MISSING','The training assignment was not found.');
  const course=courses.find(x=>x.id===row.course&&x.revision===row.courseRevision&&x.status==='published'&&x.template===quiz.id&&x.templateHash===quizHash);
  if(!course)fail(409,'TRAINING_COURSE_UNAVAILABLE','The assigned course version is no longer available.');
  return {row,course};
}
function learnerView(state,seat,id){
  const assignments=model(state).assignments.filter(x=>x.learner===seat.alias).map(row=>{
    const {course}=ownAssignment(state,seat,row.id);
    return {id:row.id,title:course.title,status:row.status,revision:row.revision,assignedAt:row.assignedAt,startedAt:row.startedAt,
      attempts:row.attempts,lastScore:row.lastScore,attemptsRemaining:attemptsPerCycle-row.cycleAttempts,receipt:row.receipt};
  });
  if(id===undefined)return {mode:'synthetic-training',assignments};
  const {row,course}=ownAssignment(state,seat,id);
  const selected=policy(state,course.policy.document,course.policy.edition,course.policy.hash);
  const summary=assignments.find(x=>x.id===id);
  return {mode:'synthetic-training',assignments,lesson:{...summary,resetAvailable:canReset(row),policy:{title:course.policy.title,number:course.policy.number,text:selected.text},
    description:quiz.lesson,questions:quiz.questions.map(({prompt,choices})=>({prompt,choices}))}};
}
function query(state,seat,action,body){
  only(body,action==='list'?['code']:['code','assignment']);
  if(action==='lesson'&&!validId(body.assignment))fail(404,'TRAINING_ASSIGNMENT_MISSING','The training assignment was not found.');
  return learnerView(state,seat,body.assignment);
}
function progress(state,seat,action,body,sign,event){
  only(body,action==='start'?['code','assignment','revision']:['code','assignment','revision','answers','confirm']);
  const {row,course}=ownAssignment(state,seat,body.assignment);
  // A retried completion request for this same assignment observes the original receipt.
  if(row.status==='completed')return false;
  if(row.revision!==body.revision)fail(409,'TRAINING_STALE','The assignment changed. Reload before retrying.');
  policy(state,course.policy.document,course.policy.edition,course.policy.hash);
  const audit=(kind,details)=>event(state,'synthetic-learner','training.'+kind,null,row.id,{course:course.id,courseRevision:course.revision,...details});
  if(action==='start'){
    if(row.status!=='assigned')return false;
    row.status='in-progress';row.startedAt=clock();row.revision++;
    audit('started',{revision:row.revision});
    return true;
  }
  if(row.status!=='in-progress')fail(409,'TRAINING_NOT_ACTIVE','Start the exercise, or ask the analyst about an exhausted assignment.');
  if(body.confirm!==true||!Array.isArray(body.answers)||body.answers.length!==quiz.questions.length||
    body.answers.some((value,index)=>!integer(value,0,quiz.questions[index].choices.length-1)))
    fail(422,'TRAINING_ANSWERS_REQUIRED','Choose one answer per question and confirm that you read the assigned policy.');
  const score=quiz.questions.reduce((total,q,index)=>total+Number(q.correct===body.answers[index]),0);
  row.attempts++;row.cycleAttempts++;row.lastScore=score;row.revision++;
  if(score===quiz.questions.length){
    row.status='completed';
    const receipt={id:randomUUID(),assignment:row.id,course:course.id,courseRevision:course.revision,learner:seat.alias,
      policyVersion:course.policy.number,policyHash:course.policy.hash,templateHash:course.templateHash,completedAt:clock(),score,total:quiz.questions.length};
    row.receipt={...receipt,signature:sign({...receipt,workspace:seat.workspace})};
    audit('completed',{receipt:receipt.id,score,total:receipt.total,revision:row.revision});
  }else{
    if(row.cycleAttempts>=attemptsPerCycle)row.status='retry-required';
    audit('attempted',{score,total:quiz.questions.length,revision:row.revision});
  }
  return true;
}
module.exports={provision,operatorView,admin,query,learnerView,progress};
