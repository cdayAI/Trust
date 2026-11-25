'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {getFixture}=require('./discovery-fixtures');
const discovery=require('./discovery-import');

const source='sample-library',versions=[1,2],maxReconciliations=2;
const pattern=/^\/api\/data-map\/discovery\/runs(?:\/([a-f0-9-]{36})\/(scan|resume|submit|approve|reconcile|apply))?$/;
const faultCode='FIXTURE_METADATA_UNAVAILABLE';
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const book=state=>state.discoveryRuns??{runs:[]};
const changed=(state,plan)=>(state.dataMap?.revision??0)!==plan.mapRevision;
const withKeys=(body,keys)=>!!body&&typeof body==='object'&&!Array.isArray(body)&&
  Object.keys(body).length===keys.length&&keys.every(key=>Object.hasOwn(body,key));

function provision(config,sqliteFile,corporate){
  if(config?.discoveryRunWorkspaces===undefined)return new Set();
  const ids=config.discoveryRunWorkspaces,known=new Set(config.workspaces.map(x=>x.id));
  if(!sqliteFile||corporate||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||
      ids.some(id=>!known.has(id)))
    throw Error('Discovery rehearsals require explicitly selected local synthetic SQLite workspaces.');
  for(const id of ids){
    const analyst=config.accounts.find(x=>x.memberships?.[id]==='analyst');
    const reviewer=config.accounts.find(x=>x.memberships?.[id]==='reviewer');
    if(!analyst||!reviewer||analyst.id===reviewer.id)throw Error('Discovery rehearsals require separate analyst and reviewer seats.');
  }
  return new Set(ids);
}

function view(state){
  return {mapRevision:state.dataMap?.revision??0,source,
    versions:discovery.fixtureOptions().filter(x=>x.source===source&&versions.includes(x.version)),
    bounds:{resumes:1,reconciliations:maxReconciliations},
    runs:book(state).runs
  };
}
function change(state,context,id,action,body,event){
  const role=action==='approve'?'reviewer':'analyst';
  if(context.actor!==role)fail(403,'DISCOVERY_ROLE_REQUIRED','This rehearsal action requires its assigned separate role.');
  const current=book(state);
  const now=new Date().toISOString();
  const append=(name,run,extra={})=>event(state,role,'data-map.discovery-run.'+name,null,run.id,
    {source:run.source,version:run.version,status:run.status,revision:run.revision,...extra});
  if(!id){
    if(!withKeys(body,['source','version'])||body.source!==source||!versions.includes(body.version))
      fail(422,'FIXTURE_SELECTION_REQUIRED','Select an available bundled synthetic library version.');
    const hit=current.runs.find(run=>run.source===source&&run.version===body.version);
    if(hit)return {run:hit,changed:false};
    const fixture=discovery.validateFixture(getFixture(source,body.version));
    const run={id:randomUUID(),source,version:body.version,fixtureDigest:digest(fixture),status:'queued',revision:1,
      createdAt:now,updatedAt:now,requestedBy:context.account,resumes:0,reconciliations:0,
      checks:[fixture.system,...fixture.datasets].map(row=>({id:row.id,name:row.name,status:'pending',code:null,fieldCount:null,metadataDigest:null})),
      review:null,result:null};
    current.runs.push(run);state.discoveryRuns=current;
    append('queued',run);
    return {run,changed:true};
  }
  const run=current.runs.find(row=>row.id===id);
  if(!run)fail(404,'DISCOVERY_RUN_NOT_FOUND','Discovery rehearsal not found.');
  if(!withKeys(body,['expectedRevision'])||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)
    fail(422,'REVISION_REQUIRED','Provide the current rehearsal revision.');
  if(body.expectedRevision!==run.revision)fail(409,'STALE_DISCOVERY_RUN','The rehearsal changed. Refresh before retrying.');
  if(role==='analyst'&&run.requestedBy!==context.account)fail(403,'DISCOVERY_OWNER_REQUIRED','Only the requesting analyst can move this rehearsal.');
  const fixture=discovery.validateFixture(getFixture(run.source,run.version));
  if(digest(fixture)!==run.fixtureDigest)fail(409,'FIXTURE_CHANGED','The bundled fixture no longer matches this rehearsal.');
  function requireStage(...stages){
    if(!stages.includes(run.status))fail(409,'DISCOVERY_STAGE_REQUIRED','This action is not available in the current rehearsal state.');
  }
  const metadata=new Map([fixture.system,...fixture.datasets].map(row=>[row.id,row]));
  function readMetadata(check){
    const row=metadata.get(check.id);
    if(!row)fail(409,'DISCOVERY_CHECKS_INVALID','The fixture no longer contains the queued metadata check.');
    check.status='complete';check.code=null;
    check.fieldCount=row.fields?.length??0;check.metadataDigest=digest(row);
  }
  const selection={source:run.source,version:run.version};
  const preview=()=>discovery.preview(state,'analyst',selection,[context.space.id,context.account,'staged-rehearsal']);
  const planOf=()=>{
    const {previewKey,...plan}=preview();
    return {previewKey,plan,fingerprint:digest([run.fixtureDigest,plan])};
  };
  const currentPlan=()=>{
    if(changed(state,run.review.plan))fail(409,'DISCOVERY_MAP_CHANGED','The inventory changed. Reconcile and obtain fresh independent approval.');
    const next=planOf();
    if(next.fingerprint!==run.review.fingerprint)fail(409,'DISCOVERY_PLAN_CHANGED','The staged plan no longer matches this rehearsal.');
    if(next.plan.conflicts.length)fail(409,'DISCOVERY_CONFLICT','Resolve the inventory conflicts and reconcile before applying.');
    return next;
  };
  let extra={};
  switch(action){
    case 'scan': {
      requireStage('queued');
      // One fixed failure, not an input-controlled failure injector and not a remote scan.
      for(const [index,check] of run.checks.entries()){
        if(index===run.checks.length-1){check.status='failed';check.code=faultCode;}
        else readMetadata(check);
      }
      run.status='partial';
      break;
    }
    case 'resume': {
      requireStage('partial');
      if(run.resumes!==0)fail(409,'DISCOVERY_RESUME_LIMIT','This rehearsal has used its one resume.');
      const failed=run.checks.filter(x=>x.status==='failed'&&x.code===faultCode);
      if(failed.length!==1)fail(409,'DISCOVERY_CHECKS_INVALID','The partial rehearsal checks cannot be reconciled.');
      readMetadata(failed[0]);
      run.resumes++;run.status='ready';
      break;
    }
    case 'submit':
    case 'reconcile': {
      if(action==='submit')requireStage('ready');
      else{
        requireStage('review','approved');
        if(run.reconciliations>=maxReconciliations)fail(409,'DISCOVERY_RECONCILE_LIMIT','This rehearsal has reached its reconciliation limit.');
        if(!changed(state,run.review.plan))fail(409,'DISCOVERY_NOT_CHANGED','The inventory has not changed.');
        run.reconciliations++;
      }
      if(run.checks.length!==metadata.size||!run.checks.every(x=>metadata.has(x.id)&&x.status==='complete'&&
        x.metadataDigest===digest(metadata.get(x.id))))
        fail(409,'DISCOVERY_CHECKS_INVALID','All fixture checks must match the reviewed metadata.');
      const {plan,fingerprint}=planOf();
      run.review={plan,fingerprint,submittedBy:context.account,submittedAt:now,approval:null};
      run.status='review';extra={mapRevision:plan.mapRevision,fingerprint};
      break;
    }
    case 'approve':{
      requireStage('review');
      if(context.account===run.review.submittedBy)fail(403,'INDEPENDENT_REVIEW_REQUIRED','A different account must approve the staged discovery plan.');
      const {fingerprint,plan}=currentPlan();
      run.review.approval={by:context.account,at:now,fingerprint,mapRevision:plan.mapRevision};
      run.status='approved';extra={fingerprint,mapRevision:plan.mapRevision};
      break;
    }
    case 'apply':{
      requireStage('approved');
      const {previewKey,plan,fingerprint}=currentPlan();
      if(run.review.approval?.fingerprint!==fingerprint||run.review.approval.mapRevision!==plan.mapRevision)
        fail(409,'DISCOVERY_APPROVAL_REQUIRED','This exact staged plan needs independent approval.');
      run.result=discovery.apply(state,'analyst',{...selection,previewKey},event,[context.space.id,context.account,'staged-rehearsal']);
      run.status='applied';extra={fingerprint,mapRevision:run.result.mapRevision};
      break;
    }
    default: fail(404,'DISCOVERY_RUN_NOT_FOUND','Discovery rehearsal not found.');
  }
  run.revision++;run.updatedAt=now;append(action,run,extra);
  return {run,changed:true};
}
module.exports={pattern,provision,view,change,hasSavedRuns:state=>state.discoveryRuns!==undefined};
