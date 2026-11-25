'use strict';
const {randomUUID,createHash}=require('node:crypto');
const records=state=>state.auditRemediation??[];
const options={
  create:['findingId','action','dueDate'],
  plan:['expectedRevision','action','dueDate'],
  submit:['expectedRevision','testId','result'],
  return:['expectedRevision','note'],
  close:['expectedRevision','note'],
  reopen:['expectedRevision','note']
};
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code})};
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function text(value,label,max=1000){
  if(typeof value!=='string'||!value.trim()||value.length>max)fail(422,'REMEDIATION_FIELD_REQUIRED','Provide '+label+' (1–'+max+' characters).');
  return value.trim();
}
function date(value,minimum){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'2000-01-01'||value>'2200-12-31')
    fail(422,'REMEDIATION_BAD_DATE','Choose a valid UTC calendar date.');
  const parsed=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==value||value<minimum)
    fail(422,'REMEDIATION_BAD_DATE','The due date must be a valid UTC date on or after the start of the current action.');
  return value;
}
function findings(state){
  return (state.auditManagement?.plans??[]).flatMap(plan=>
    (plan.final?.result.controls??[]).flatMap(({control,assessment})=>
      assessment.finding?[{id:assessment.finding.id,planId:plan.id,plan:plan.title,auditSha256:plan.final.sha256,
        controlId:control.id,control:control.title,severity:assessment.finding.severity,
        proposedAction:assessment.finding.correctiveAction,finalizedAt:plan.final.result.reviewHistory.at(-1).at}]:[]));
}
function newestFor(state,controlId){return (state.riskControls?.tests??[]).findLast(x=>x.controlId===controlId)}
function independentTest(test){
  return !!(test?.reviewStatus==='accepted'&&test.reviewedAt&&test.recordedByAccount&&test.reviewedByAccount&&test.recordedByAccount!==test.reviewedByAccount);
}
function proof(state,row,id){
  const test=newestFor(state,row.finding.controlId);
  if(!test||test.id!==id||test.outcome!=='pass'||!independentTest(test)||test.recordedAt<row.proofAfter)
    fail(422,'REMEDIATION_RETEST_REQUIRED','Select the latest independently accepted passing retest on this exact control, recorded after the action began.');
  return {id:test.id,controlId:test.controlId,outcome:test.outcome,evidenceReference:test.evidenceReference,
    recordedAt:test.recordedAt,reviewedAt:test.reviewedAt,recordedBy:test.recordedByAccount,reviewedBy:test.reviewedByAccount};
}
function attemptStatus(state,row){
  const last=row.attempts.at(-1);
  if(!last||!['in_review','closed'].includes(row.status))return null;
  const test=newestFor(state,row.finding.controlId);
  if(test?.id===last.proof.id)return 'current';
  return test?.outcome==='fail'?'superseded-by-failure':'superseded';
}
function regression(state,row){
  const test=newestFor(state,row.finding.controlId),last=row.attempts.at(-1);
  return test?.outcome==='fail'&&independentTest(test)&&test.recordedAt>=last?.decision?.at?test:null;
}
function view(state,{now=Date.now()}={}){
  const all=records(state),today=new Date(now).toISOString().slice(0,10);
  const byFinding=new Map(all.map(row=>[row.finding.id,row]));
  const byPlan=Object.create(null);
  for(const finding of findings(state)){
    const row=byFinding.get(finding.id),test=row&&newestFor(state,finding.controlId);
    let eligible=null;
    if(test){try{eligible=proof(state,row,test.id)}catch(e){if(!e.status)throw e;}}
    (byPlan[finding.planId]??=[]).push({...finding,action:row?{...row,retake:eligible,
      deadline:row.status==='closed'?'closed':row.dueDate<today?'overdue':row.dueDate===today?'due_today':'scheduled',
      evidenceState:attemptStatus(state,row),reopenAvailable:row.status==='closed'&&!!regression(state,row)}:null});
  }
  return byPlan;
}
function report(state,id){
  const row=records(state).find(x=>x.id===id);
  if(!row)fail(404,'REMEDIATION_NOT_FOUND','Corrective action not found in this workspace.');
  const prior=row.attempts.filter(x=>x.decision?.outcome==='closed').map(x=>({result:x.closure,sha256:x.closureSha256}));
  if(!prior.length)fail(409,'REMEDIATION_NOT_CLOSED','This action does not yet have approved closure evidence.');
  return {schemaVersion:1,scope:'synthetic-audit-remediation',findingId:row.finding.id,closures:prior};
}
function change(state,parts,actor,body,event,_unused,account,{now=Date.now()}={}){
  const [,collection,id,action]=parts,op=parts.length===2?'create':action;
  if(collection!=='remediations'||![2,4].includes(parts.length)||!Object.hasOwn(options,op)||parts.length===4&&op==='create')
    fail(404,'REMEDIATION_ROUTE','Corrective action not found.');
  const review=['return','close','reopen'].includes(op),identity=account??actor;
  if(actor!==(review?'reviewer':'analyst'))
    fail(403,'REMEDIATION_ROLE_REQUIRED',review?'An independent reviewer must take this action.':'The assigned analyst must take this action.');
  if(Object.keys(body).length!==options[op].length||options[op].some(key=>!Object.hasOwn(body,key)))
    fail(422,'REMEDIATION_FIELDS','Provide only the required corrective action fields.');
  const registered=state.auditRemediation??=[],at=new Date(now).toISOString(),today=at.slice(0,10);
  let row;
  if(op==='create'){
    const finding=findings(state).find(item=>item.id===body.findingId);
    if(!finding)fail(404,'FINAL_FINDING_REQUIRED','Choose a current exception from a finalized audit in this workspace.');
    if(registered.some(item=>item.finding.id===finding.id))fail(409,'REMEDIATION_EXISTS','This finding already has a corrective action.');
    if(registered.length>=500)fail(409,'REMEDIATION_LIMIT','This workspace has reached its corrective-action limit.');
    row={id:randomUUID(),owner:identity,finding,status:'open',action:text(body.action,'a corrective action'),
      dueDate:date(body.dueDate,today),proofAfter:at,createdAt:at,revision:1,attempts:[],reopened:[]};
    registered.push(row);
  }else{
    row=registered.find(item=>item.id===id);
    if(!row)fail(404,'REMEDIATION_NOT_FOUND','Corrective action not found in this workspace.');
    if(review&&identity===row.owner||!review&&identity!==row.owner)
      fail(403,review?'REMEDIATION_INDEPENDENCE_REQUIRED':'REMEDIATION_OWNER_REQUIRED',
        review?'A reviewer cannot decide their own corrective action.':'Only the assigned analyst account can change this corrective action.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)fail(422,'REMEDIATION_REVISION_REQUIRED','Provide the current corrective action revision.');
    if(body.expectedRevision!==row.revision)fail(409,'STALE_REVISION','The corrective action changed. Reload before retrying.');
    const staged=['open','returned'].includes(row.status),last=row.attempts.at(-1);
    if(op==='plan'&&staged){
      const action=text(body.action,'a corrective action'),dueDate=date(body.dueDate,row.proofAfter.slice(0,10));
      if(action!==row.action)row.proofAfter=at;
      Object.assign(row,{action,dueDate});
    }else if(op==='submit'&&staged){
      if(row.attempts.length>=50)fail(409,'REMEDIATION_LIMIT','This action has reached its evidence attempt limit.');
      const evidence=proof(state,row,body.testId);
      if(row.attempts.some(x=>x.proof.id===evidence.id))fail(409,'REMEDIATION_FRESH_EVIDENCE','Record and approve a new passing retest for another submission.');
      row.attempts.push({number:row.attempts.length+1,at,submittedBy:identity,action:row.action,dueDate:row.dueDate,
        result:text(body.result,'a remediation result'),proof:evidence,decision:null});
      row.status='in_review';
    }else if((op==='return'||op==='close')&&row.status==='in_review'){
      const note=text(body.note,'an independent review note',500);
      if(op==='close'){
        try{proof(state,row,last.proof.id)}catch(error){if(!error.status)throw error;
          fail(409,'REMEDIATION_EVIDENCE_CHANGED','The retest is no longer current. Return this attempt for new evidence.');}
      }
      last.decision={outcome:op==='close'?'closed':'returned',at,reviewer:identity,note};
      if(op==='close'){
        last.closure=structuredClone({actionId:row.id,owner:row.owner,finding:row.finding,attempt:last});
        last.closureSha256=digest(last.closure);
      }
      row.status=op==='close'?'closed':'returned';
    }else if(op==='reopen'&&row.status==='closed'){
      const test=regression(state,row);
      if(!test)
        fail(409,'REMEDIATION_NOT_REGRESSED','Reopen only after a newer independently accepted failing retest demonstrates regression.');
      row.reopened.push({at,reviewer:identity,note:text(body.note,'a reopening rationale',500),failureTestId:test.id,priorAttempt:last.number});
      row.status='open';
      row.proofAfter=at;
    }else fail(409,'REMEDIATION_WRONG_STAGE','This transition is unavailable in the current corrective action stage.');
    row.revision++;
  }
  event(state,actor,'audit-remediation.'+op,null,row.id,{findingId:row.finding.id,auditId:row.finding.planId,revision:row.revision,
    actor:identity,status:row.status,attempt:row.attempts.at(-1)?.number??null});
}
module.exports={view,change,report};
