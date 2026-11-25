'use strict';
const {randomUUID}=require('node:crypto');
const outcomes=['pass','fail'];
const axes=['likelihood','impact'];
const rules={version:1,inputMin:1,inputMax:5,reductionMax:2,stacking:'largest verified reduction per dimension, not the sum'};
const boardOf=s=>s.riskControls??{revision:0,risks:[],controls:[],links:[],tests:[]};
function error(status,code,message){throw Object.assign(new Error(message),{status,code})}
function only(body,keys){if(Object.keys(body).some(k=>!keys.includes(k)))error(422,'UNKNOWN_FIELDS','Provide only the supported fields.')}
function required(x,label,max=1000){
  if(typeof x!=='string'||!x.trim()||x.length>max)error(422,'FIELD_REQUIRED',label+' is required and must be at most '+max+' characters.');
  return x.trim();
}
function int(x,min,max,field){
  if(!Number.isSafeInteger(x)||x<min||x>max)error(422,'INVALID_SCORE',field+' must be an integer from '+min+' to '+max+'.');
  return x;
}
function find(rows,id,label){return rows.find(row=>row.id===id)??error(404,'RECORD_NOT_FOUND',label+' not found.')}
function score(likelihood,impact){
  const value=likelihood*impact;
  return {likelihood,impact,value,tier:value>=20?'critical':value>=12?'high':value>=6?'moderate':'low'};
}
function view(state){
  const board=boardOf(state);
  const latest=new Map(board.tests.map(t=>[t.controlId,t]));
  const linksByRisk=new Map(board.risks.map(r=>[r.id,[]]));
  for(const link of board.links){
    const t=latest.get(link.controlId);
    const reason=link.archivedAt?'unlinked':!link.reviewedBy?'link-awaiting-review':!t?'untested':t.outcome==='fail'?'latest-test-failed':
      t.reviewStatus==='accepted'?'verified-pass':t.reviewStatus==='rejected'?'review-rejected':'awaiting-independent-review';
    linksByRisk.get(link.riskId).push({...link,reason,applies:reason==='verified-pass',testId:t?.id??null});
  }
  const risks=board.risks.map(r=>{
    const links=linksByRisk.get(r.id);
    const reduction={likelihood:0,impact:0};
    for(const l of links)if(l.applies)for(const axis of axes)reduction[axis]=Math.max(reduction[axis],l.reduction[axis]);
    return {...r,inherent:score(r.likelihood,r.impact),
      residual:score(Math.max(1,r.likelihood-reduction.likelihood),Math.max(1,r.impact-reduction.impact)),reduction,links};
  });
  return {...board,risks,rules,outcomes,
    controls:board.controls.map(c=>({...c,latestTestId:latest.get(c.id)?.id??null})),
    legacyRecords:(state.moduleRecords??[]).filter(r=>['risks','controls'].includes(r.moduleId))};
}
const fields={
  risks:{create:['title','scenario','likelihood','impact'],score:['likelihood','impact','note']},
  controls:{create:['title','intent']},
  links:{create:['riskId','controlId','likelihoodReduction','impactReduction','note'],unlink:['note'],verify:['note']},
  tests:{create:['controlId','outcome','evidenceReference','note'],accept:['note'],reject:['note']}
};
function change(state,parts,actor,body,event,_startAssessments,account){
  const identity=account??actor;
  const board=state.riskControls??=boardOf(state);
  const [,collection,id,rawAction]=parts, action=parts.length===2?'create':rawAction;
  if(!Object.hasOwn(fields,collection)||!Object.hasOwn(fields[collection],action)||
     !(parts.length===2||(parts.length===4&&action!=='create')))error(404,'NOT_FOUND','Risk and controls action not found.');
  const audit=(kind,target,details)=>event(state,actor,'risk-controls.'+kind,null,target,{...details,revision:board.revision,scoreRuleVersion:rules.version});
  try{
    only(body,['expectedRevision',...fields[collection][action]]);
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)error(422,'REVISION_REQUIRED','Provide the current risk and controls revision.');
    if(body.expectedRevision!==board.revision)error(409,'STALE_REVISION','Risk and controls changed. Reload before retrying.');
    const review=(collection==='tests'&&action!=='create')||(collection==='links'&&action==='verify');
    if(actor!==(review?'reviewer':'analyst'))error(403,review?'INDEPENDENT_REVIEW_REQUIRED':'ANALYST_REQUIRED',
      review?'A separate reviewer must decide the result.':'Only the risk and controls analyst may take this action.');
    let row,details;
    const now=new Date().toISOString();
    if(collection==='risks'){
      const calculation=score(int(body.likelihood,1,5,'Likelihood'),int(body.impact,1,5,'Impact'));
      if(action==='create'){
        row={id:randomUUID(),title:required(body.title,'Fictional risk title',120),scenario:required(body.scenario,'Fictional risk scenario'),
          likelihood:calculation.likelihood,impact:calculation.impact,createdAt:now,updatedAt:now};
        board.risks.push(row);details={...row,inherent:calculation};
      }else{
        row=find(board.risks,id,'Risk');
        const note=required(body.note,'Re-score rationale');
        details={previous:score(row.likelihood,row.impact),inherent:calculation,note};
        Object.assign(row,{likelihood:calculation.likelihood,impact:calculation.impact,updatedAt:now});
      }
    }else if(collection==='controls'){
      row={id:randomUUID(),title:required(body.title,'Fictional control title',120),intent:required(body.intent,'Fictional control objective'),createdAt:now};
      board.controls.push(row);details={...row};
    }else if(collection==='links'){
      const note=required(body.note,'Mitigation rationale');
      if(action==='create'){
        const risk=find(board.risks,body.riskId,'Risk'),control=find(board.controls,body.controlId,'Control');
        if(board.links.some(x=>!x.archivedAt&&x.riskId===risk.id&&x.controlId===control.id))error(409,'LINK_EXISTS','This risk already links to this control.');
        const reduction={likelihood:int(body.likelihoodReduction,0,2,'Likelihood reduction'),impact:int(body.impactReduction,0,2,'Impact reduction')};
        if(!(reduction.likelihood||reduction.impact))error(422,'INVALID_SCORE','Choose a reduction for at least one dimension.');
        row={id:randomUUID(),riskId:risk.id,controlId:control.id,reduction,note,createdAt:now,archivedAt:null,reviewedBy:null,reviewedAt:null,reviewNote:null};
        board.links.push(row);details={...row};
      }else{
        row=find(board.links,id,'Mitigation link');
        if(row.archivedAt)error(409,'LINK_INACTIVE','This mitigation link is no longer active.');
        if(action==='verify'){
          if(row.reviewedBy)error(409,'LINK_ALREADY_VERIFIED','This link is already verified.');
          Object.assign(row,{reviewedBy:actor,reviewedAt:now,reviewNote:note});
        }else row.archivedAt=now;
        details={riskId:row.riskId,controlId:row.controlId,note};
      }
    }else if(action==='create'){
      const control=find(board.controls,body.controlId,'Control');
      if(!outcomes.includes(body.outcome))error(422,'INVALID_RESULT','Choose a passing or failing result.');
      if(typeof body.evidenceReference!=='string'||!/^SYN-[A-Z0-9]{3,24}$/.test(body.evidenceReference))
        error(422,'INVALID_EVIDENCE','Use a fictional evidence reference such as SYN-CHECK01.');
      row={id:randomUUID(),controlId:control.id,outcome:body.outcome,evidenceReference:body.evidenceReference,note:required(body.note,'Fictional test note'),
        recordedBy:actor,recordedByAccount:identity,recordedAt:now,reviewStatus:'pending',reviewedBy:null,reviewedAt:null,reviewNote:null};
      board.tests.push(row);details={...row};
    }else{
      row=find(board.tests,id,'Control test');
      if(row.recordedBy===actor||row.recordedByAccount===identity)error(403,'INDEPENDENT_REVIEW_REQUIRED','A separate reviewer must decide the result.');
      if(row.reviewStatus!=='pending')error(409,'TEST_IMMUTABLE','This test has already been reviewed.');
      if(board.tests.findLast(t=>t.controlId===row.controlId)?.id!==row.id)error(409,'SUPERSEDED_TEST','Review the current test; a newer test superseded this one.');
      const reviewNote=required(body.note,'Fictional review evidence note');
      Object.assign(row,{reviewNote,reviewStatus:action==='accept'?'accepted':'rejected',reviewedBy:actor,reviewedByAccount:identity,reviewedAt:now});
      details={...row};
    }
    board.revision++;
    audit(collection+'.'+action,row.id,details);
  }catch(e){
    if(!e.status)throw e;
    audit('refused',id??null,{collection,action,code:e.code,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null});
    throw Object.assign(e,{persistRefusal:true});
  }
}
module.exports={view,change};
