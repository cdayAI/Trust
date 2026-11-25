'use strict';
const {createHash,randomUUID}=require('node:crypto');
const identity=require('./identity-admin');
const name=/^sample-[a-z0-9][a-z0-9-]{0,39}$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const reasons=['end-of-assignment','directory-reconciliation','access-review'];
const authorities=['identity-admin','reviewer'];
const states=['draft','review','approved','rejected','cancelled'];
const maxPlans=50,maxTargets=12,window=7*86400000;
const has=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const exact=(body,keys)=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===keys.length&&keys.every(k=>Object.hasOwn(body,k));
const stale=()=>fail(409,'DIRECTORY_PLAN_STALE','The roster or plan changed. Reload and prepare a new plan if needed.');
function provision(isolated,synthetic){
  const ids=isolated?.directoryLifecycleWorkspaces;
  if(ids===undefined)return new Set();
  if(!synthetic)throw Error('Directory reconciliation is limited to the local synthetic workbench.');
  if(isolated.enableIdentityAdmin!==true||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||
    !Array.isArray(isolated.accounts)||!Array.isArray(isolated.workspaces))
    throw Error('Directory reconciliation requires isolated identity administration and explicit workspaces.');
  for(const id of ids){
    if(!isolated.workspaces.some(w=>w.id===id))throw Error('Directory reconciliation names an unknown workspace.');
    const seats=isolated.accounts.filter(x=>Object.hasOwn(x.memberships??{},id));
    const admin=seats.find(x=>x.memberships[id]==='identity-admin'),review=seats.find(x=>x.memberships[id]==='reviewer');
    if(!admin||!review||admin.id===review.id||!seats.every(x=>has(name,x.id))||
      !seats.some(x=>!authorities.includes(x.memberships[id])))
      throw Error('Directory reconciliation requires distinct sample administrator and reviewer seats and an eligible sample seat.');
  }
  return new Set(ids);
}
function digest(plan){
  return createHash('sha256').update(JSON.stringify(['mvw-directory-suspension-v1',plan.workspace,plan.id,
    plan.number,plan.reason,plan.preparedBy,plan.preparedAt,plan.expiresAt,
    plan.members.map(({account,role,before,after})=>[account,role,before.revision,before.disabled,after.revision,after.disabled])])).digest('hex');
}
function read(state,workspace){
  const board=state.directoryLifecycle;
  if(board===undefined)return {schemaVersion:1,revision:0,plans:[]};
  const bad=()=>{throw Error('Invalid directory reconciliation state.');};
  if(board?.schemaVersion!==1||!Number.isSafeInteger(board.revision)||board.revision<0||
    !Array.isArray(board.plans)||board.plans.length>maxPlans)bad();
  const ids=new Set();
  for(const [i,row] of board.plans.entries()){
    if(!row||!has(uuid,row.id)||ids.has(row.id)||row.workspace!==workspace||row.number!==i+1||
      !reasons.includes(row.reason)||!states.includes(row.status)||!has(name,row.preparedBy)||!has(hash,row.preparedBinding)||
      !Number.isSafeInteger(row.preparedGeneration)||row.preparedGeneration<0||
      !Number.isSafeInteger(row.preparedAt)||!Number.isSafeInteger(row.expiresAt)||row.expiresAt!==row.preparedAt+window||
      !Array.isArray(row.members)||row.members.length<1||row.members.length>maxTargets||
      new Set(row.members.map(m=>m?.account)).size!==row.members.length||
      row.members.some(m=>!m||!has(name,m.account)||typeof m.role!=='string'||authorities.includes(m.role)||!has(hash,m.binding)||
        !Number.isSafeInteger(m.before?.revision)||m.before.revision<0||m.before.disabled!==false||
        !Number.isSafeInteger(m.after?.revision)||m.after.revision!==m.before.revision+1||m.after.disabled!==true)||
      row.digest!==digest(row))bad();
    if(['approved','rejected'].includes(row.status)&&(!has(name,row.decidedBy)||row.decidedBy===row.preparedBy||
      !Number.isSafeInteger(row.decidedAt)))bad();
    ids.add(row.id);
  }
  return board;
}
function localSeat(state,ctx,id,role){
  const seat=ctx.roster.find(x=>x.id===id&&(role===undefined||x.role===role));
  if(!seat||!has(name,seat.id)||!has(hash,seat.provisioning)||seat.configuredDisabled||
    (seat.validUntil!==null&&ctx.at>=seat.validUntil))return undefined;
  const current=identity.record(state,id);
  return {...seat,current};
}
function authority(state,ctx,roles){
  if(!ctx.enabled||!roles.includes(ctx.role))
    fail(403,'DIRECTORY_PLAN_AUTHORITY','This workspace role cannot perform that directory action.');
  const seat=localSeat(state,ctx,ctx.account,ctx.role);
  if(!seat||seat.current.disabled||seat.current.revision!==ctx.generation)
    fail(401,'DIRECTORY_SESSION_INACTIVE','Sign in to a local workspace.');
  return seat;
}
function eligible(state,ctx,id){
  const seat=localSeat(state,ctx,id);
  if(!seat||seat.current.disabled||authorities.includes(seat.role))return undefined;
  const after=seat.current.revision+1;
  if(!Number.isSafeInteger(after))throw Error('Account access generation overflow.');
  return {account:id,role:seat.role,binding:seat.provisioning,before:seat.current,after:{revision:after,disabled:true}};
}
function canApply(state,ctx,plan){
  const maker=localSeat(state,ctx,plan.preparedBy,'identity-admin');
  if(!maker||maker.current.disabled||maker.current.revision!==plan.preparedGeneration||
    maker.provisioning!==plan.preparedBinding||ctx.at>=plan.expiresAt)return false;
  return plan.members.every(m=>{
    const seat=eligible(state,ctx,m.account);
    return seat&&seat.role===m.role&&seat.binding===m.binding&&seat.before.revision===m.before.revision;
  });
}
function view(state,ctx){
  authority(state,ctx,authorities);
  const board=read(state,ctx.workspace),admin=ctx.role==='identity-admin';
  const plans=board.plans.map(plan=>{
    const active=['draft','review'].includes(plan.status),current=active&&canApply(state,ctx,plan);
    const {preparedBinding,preparedGeneration,members,...visible}=plan;
    const allowed=active?(admin?['cancel',...(current&&plan.status==='draft'&&plan.preparedBy===ctx.account?['submit']:[])]:
      plan.status==='review'&&plan.preparedBy!==ctx.account?['reject',...(current?['approve']:[])]:[]):[];
    return {...visible,members:members.map(({binding,...m})=>m),current,allowed};
  }).reverse();
  const candidates=admin?ctx.roster.flatMap(({id})=>{
    const seat=eligible(state,ctx,id);
    return seat?[{account:seat.account,role:seat.role,revision:seat.before.revision}]:[];
  }):undefined;
  return {role:ctx.role,revision:board.revision,plans,reasons,maxTargets,
    ...(admin?{candidates}:{}),audit:state.audit.filter(row=>row.action.startsWith('directory-lifecycle.')).slice(-40).reverse()
      .map(row=>({at:row.at,actor:row.account,action:row.action.slice(20),target:row.entityId,...row.details}))};
}
function change(state,ctx,body,event){
  const op=body?.operation,author=['draft','submit','cancel'].includes(op),drafting=op==='draft';
  const acting=authority(state,ctx,[author?'identity-admin':'reviewer']);
  if(!['draft','submit','cancel','approve','reject'].includes(op)||
    !exact(body,drafting?['operation','expectedRevision','accounts','reason']:['operation','expectedRevision','plan','digest'])||
    !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||
    (drafting?(!Array.isArray(body.accounts)||body.accounts.length<1||body.accounts.length>maxTargets||
      new Set(body.accounts).size!==body.accounts.length||!body.accounts.every(value=>has(name,value))||!reasons.includes(body.reason)):
      (!has(uuid,body.plan)||!has(hash,body.digest))))
    fail(422,'INVALID_DIRECTORY_PLAN','Choose exact sample accounts, a reason, and the current plan revision or digest.');
  const board=read(state,ctx.workspace);
  if(board.revision!==body.expectedRevision)stale();
  let plan;
  if(drafting){
    if(board.plans.length>=maxPlans)fail(409,'DIRECTORY_PLAN_LIMIT','This workspace has reached the synthetic plan limit.');
    const members=body.accounts.slice().sort().map(id=>eligible(state,ctx,id));
    if(members.some(row=>!row))fail(422,'DIRECTORY_TARGET_INELIGIBLE','Select only active eligible sample accounts in this workspace.');
    const expiresAt=ctx.at+window;
    if(!Number.isSafeInteger(expiresAt))throw Error('Directory reconciliation expiry overflow.');
    plan={id:randomUUID(),workspace:ctx.workspace,number:board.plans.length+1,reason:body.reason,status:'draft',
      preparedBy:ctx.account,preparedBinding:acting.provisioning,preparedGeneration:acting.current.revision,preparedAt:ctx.at,expiresAt,members};
    plan.digest=digest(plan);board.plans.push(plan);
  }else{
    plan=board.plans.find(row=>row.id===body.plan);
    if(!plan)fail(404,'DIRECTORY_PLAN_NOT_FOUND','That directory plan was not found.');
    if(plan.digest!==body.digest)stale();
    if((op==='submit'&&(plan.status!=='draft'||plan.preparedBy!==ctx.account))||
      (op==='cancel'&&!['draft','review'].includes(plan.status))||
      (['approve','reject'].includes(op)&&plan.status!=='review'))
      fail(409,'DIRECTORY_PLAN_TRANSITION','That decision is not available for this plan.');
    if(!author&&plan.preparedBy===ctx.account)
      fail(403,'DIRECTORY_INDEPENDENT_REVIEW','A separate account must decide this plan.');
    if(['submit','approve'].includes(op)&&!canApply(state,ctx,plan))stale();
    if(op==='approve'){
      identity.applySuspensionPlan(state,plan.members);
      for(const m of plan.members)event(state,'directory-lifecycle.member-suspended',m.account,{
        plan:plan.id,digest:plan.digest,before:m.before,after:m.after
      });
    }
    plan.status=({submit:'review',cancel:'cancelled',approve:'approved',reject:'rejected'})[op];
    if(!author){plan.decidedBy=ctx.account;plan.decidedAt=ctx.at;}
  }
  board.revision++;
  if(!Number.isSafeInteger(board.revision))throw Error('Directory board revision overflow.');
  state.directoryLifecycle=board;
  event(state,'directory-lifecycle.'+op,plan.id,{digest:plan.digest,revision:board.revision,number:plan.number});
  return view(state,ctx);
}
module.exports={provision,view,change};
