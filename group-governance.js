'use strict';

const {createHash}=require('node:crypto');
const identity=require('./identity-admin');
const slug=/^[a-z][a-z0-9-]{0,47}$/;
const grantable=new Set(['analyst','case-operator']);
const ttl=30*24*60*60*1000;
const groupLimit=32, relationshipLimit=320;
const actions=Object.freeze({
  'create-group':['group','expectedRevision'],
  'archive-group':['group','expectedRevision'],
  'propose-member':['group','target','expectedRevision'],
  'propose-app':['group','target','expectedRevision'],
  'approve':['group','kind','target','expectedRevision'],
  'reject':['group','kind','target','expectedRevision'],
  'revoke':['group','kind','target','expectedRevision']
});
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const isSlug=value=>typeof value==='string'&&slug.test(value);
const isKind=value=>['member','app'].includes(value);
const plain=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
const stamp=arr=>createHash('sha256').update(JSON.stringify(arr)).digest('hex');
const validStamp=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

function provision(isolated){
  const maps=new Map();
  if(isolated?.groupApplications===undefined)return maps;
  if(isolated.enableIdentityAdmin!==true||!Array.isArray(isolated.groupApplications)||!isolated.groupApplications.length||
    !Array.isArray(isolated.workspaces)||!Array.isArray(isolated.accounts))
    throw Error('Group governance requires isolated identity administration and an explicit app catalog.');
  for(const entry of isolated.groupApplications){
    if(!plain(entry,['workspace','applications'])||!isolated.workspaces.some(x=>x.id===entry.workspace)||maps.has(entry.workspace)||
      !Array.isArray(entry.applications)||!entry.applications.length||entry.applications.length>48)
      throw Error('Invalid workspace app catalog.');
    const admins=isolated.accounts.filter(x=>Object.hasOwn(x.memberships??{},entry.workspace)&&x.memberships[entry.workspace]==='identity-admin');
    const reviewers=isolated.accounts.filter(x=>Object.hasOwn(x.memberships??{},entry.workspace)&&x.memberships[entry.workspace]==='reviewer');
    if(admins.length!==1||reviewers.length!==1||admins[0].id===reviewers[0].id)
      throw Error('Group governance requires distinct provisioned local identity admin and reviewer accounts.');
    const catalog=new Map();
    for(const app of entry.applications){
      if(!plain(app,['id','name','summary'])||!isSlug(app.id)||catalog.has(app.id)||
        typeof app.name!=='string'||!app.name.trim()||app.name.length>96||
        typeof app.summary!=='string'||!app.summary.trim()||app.summary.length>280||
        /[\x00-\x1f\x7f]/.test(app.name+app.summary))
        throw Error('Invalid synthetic app summary.');
      const projection={id:app.id,name:app.name,summary:app.summary};
      catalog.set(app.id,{...projection,fingerprint:stamp([app.id,app.name,app.summary])});
    }
    maps.set(entry.workspace,catalog);
  }
  return maps;
}
function boardOf(state){
  const b=state.groupGovernance;
  if(b===undefined)return {schemaVersion:1,revision:0,groups:[],relationships:[]};
  const notValid=()=>{throw Error('Invalid group governance state.');};
  if(b?.schemaVersion!==1||!Number.isSafeInteger(b.revision)||b.revision<0||
    !Array.isArray(b.groups)||b.groups.length>groupLimit||!Array.isArray(b.relationships)||b.relationships.length>relationshipLimit)
    notValid();
  const known=new Set(), links=new Set();
  for(const g of b.groups){
    if(!g||!isSlug(g.id)||known.has(g.id)||typeof g.archived!=='boolean')notValid();
    known.add(g.id);
  }
  for(const r of b.relationships){
    if(!r||!isKind(r.kind)||!known.has(r.group)||!isSlug(r.target)||!isSlug(r.proposedBy)||!validStamp(r.fingerprint)||
      !['pending','approved','rejected','revoked'].includes(r.status))notValid();
    const key=r.group+'/'+r.kind+'/'+r.target;
    if(links.has(key))notValid();
    links.add(key);
    if(r.status==='approved'&&(!Number.isSafeInteger(r.expiresAt)||r.expiresAt<1||
      !isSlug(r.approvedBy)||r.approvedBy===r.proposedBy))notValid();
  }
  return b;
}
const active=(state,seat,at)=>seat&&!seat.configuredDisabled&&
  (seat.validUntil===null||at<seat.validUntil)&&!identity.record(state,seat.id).disabled;
function fingerprint(state,context,kind,target){
  if(kind==='app')return context.catalog.get(target)?.fingerprint;
  const seat=context.roster.find(seat=>seat.id===target);
  if(!active(state,seat,context.at)||!grantable.has(seat.role))return undefined;
  return stamp([seat.id,seat.role,seat.provisioning,identity.record(state,seat.id).revision]);
}
function currentStatus(state,context,r){
  if(!['pending','approved'].includes(r.status))return r.status;
  if(fingerprint(state,context,r.kind,r.target)!==r.fingerprint)return 'stale';
  if(r.status==='approved'&&context.at>=r.expiresAt)return 'expired';
  return r.status;
}
function authority(state,context,roles){
  const seat=context.roster.find(x=>x.id===context.account&&x.role===context.role);
  if(!active(state,seat,context.at)||identity.record(state,context.account).revision!==context.generation)
    fail(401,'GROUP_SESSION_INACTIVE','Sign in to a local workspace.');
  if(!roles.includes(context.role))
    fail(403,'GROUP_AUTHORITY_REQUIRED','Your current local workspace role is not authorized for group governance.');
}
function operatorView(state,context){
  authority(state,context,['identity-admin','reviewer']);
  const {revision,groups,relationships}=boardOf(state);
  const audit=state.audit.filter(e=>e.action.startsWith('group-governance.')).slice(-40).reverse().map(e=>
    ({at:e.at,actor:e.details.account,action:e.action.slice(17),group:e.entityId,kind:e.details.kind,target:e.details.target,revision:e.details.revision}));
  const projection=relationships.map(r=>{
    const status=currentStatus(state,context,r);
    const app=r.kind==='app'&&status==='pending'?context.catalog.get(r.target):null;
    return {kind:r.kind,group:r.group,target:r.target,status,
      proposedBy:r.proposedBy,approvedBy:r.approvedBy,expiresAt:r.expiresAt,
      ...(app?{application:{name:app.name,summary:app.summary}}:{})};
  });
  const result={role:context.role,revision,groups:groups.map(g=>({...g})),relationships:projection,audit};
  if(context.role==='identity-admin'){
    result.eligibleMembers=context.roster.filter(seat=>grantable.has(seat.role)&&active(state,seat,context.at))
      .map(({id,role})=>({id,role}));
    result.catalog=[...context.catalog.values()].map(({id,name})=>({id,name}));
  }
  return result;
}
function list(state,context){
  authority(state,context,[...grantable]);
  const {groups,relationships}=boardOf(state);
  const activeGroups=new Set(groups.filter(g=>!g.archived).map(g=>g.id));
  const matching=new Set(relationships.filter(r=>r.kind==='member'&&r.target===context.account&&activeGroups.has(r.group)&&
    currentStatus(state,context,r)==='approved').map(r=>r.group));
  const allowed=new Set(relationships.filter(r=>r.kind==='app'&&matching.has(r.group)&&
    currentStatus(state,context,r)==='approved').map(r=>r.target));
  return {applications:[...context.catalog.values()].filter(app=>allowed.has(app.id)).map(({id,name,summary})=>({id,name,summary}))};
}
function change(state,context,body,event){
  if(!body||typeof body.operation!=='string'||!Object.hasOwn(actions,body.operation)||
    !plain(body,['operation',...actions[body.operation]])||!Number.isSafeInteger(body.expectedRevision)||
    body.expectedRevision<0||!isSlug(body.group)||
    (Object.hasOwn(body,'target')&&!isSlug(body.target))||(Object.hasOwn(body,'kind')&&!isKind(body.kind)))
    fail(422,'INVALID_GROUP_ACTION','Choose a group, valid operation, and current revision.');
  const op=body.operation,isDecision=op==='approve'||op==='reject';
  authority(state,context,[isDecision?'reviewer':'identity-admin']);
  const board=boardOf(state);
  if(board.revision!==body.expectedRevision)
    fail(409,'STALE_GROUP_BOARD','Group governance changed. Reload before retrying.');
  const group=board.groups.find(x=>x.id===body.group);
  if(op==='create-group'){
    if(group)fail(409,'GROUP_EXISTS','This group ID cannot be reused.');
    if(board.groups.length>=groupLimit)fail(409,'GROUP_LIMIT','This workspace has reached its local group limit.');
    board.groups.push({id:body.group,archived:false});
  }else{
    if(!group||group.archived)fail(404,'GROUP_UNAVAILABLE','This active group is not available.');
    if(op==='archive-group')group.archived=true;
  }
  const kind=op==='propose-member'?'member':op==='propose-app'?'app':body.kind;
  if(kind){
    const existing=board.relationships.findIndex(x=>x.group===group.id&&x.kind===kind&&x.target===body.target);
    const current=board.relationships[existing];
    const status=current&&currentStatus(state,context,current);
    if(op.startsWith('propose-')){
      if(['pending','approved'].includes(status))fail(409,'RELATIONSHIP_EXISTS','That exact relationship is already pending or approved.');
      const binding=fingerprint(state,context,kind,body.target);
      if(!binding)fail(422,'SUBJECT_NOT_ELIGIBLE','That subject is not eligible in this workspace.');
      if(existing<0&&board.relationships.length>=relationshipLimit)
        fail(409,'RELATIONSHIP_LIMIT','This workspace has reached its local relationship limit.');
      const next={group:group.id,kind,target:body.target,proposedBy:context.account,status:'pending',fingerprint:binding};
      if(existing<0)board.relationships.push(next);else board.relationships[existing]=next;
    }else if(isDecision){
      if(status!=='pending')fail(409,'PROPOSAL_UNAVAILABLE','That proposal is no longer pending and eligible.');
      if(current.proposedBy===context.account)fail(403,'INDEPENDENT_REVIEW_REQUIRED','Use a different provisioned account to review.');
      current.status=op==='approve'?'approved':'rejected';
      if(op==='approve'){
        current.approvedBy=context.account;current.expiresAt=context.at+ttl;
        if(!Number.isSafeInteger(current.expiresAt))throw Error('Invalid scope expiry.');
      }
    }else{
      if(!['pending','approved'].includes(status))fail(409,'RELATIONSHIP_UNAVAILABLE','That relationship is no longer revocable.');
      current.status='revoked';
    }
  }
  board.revision++;
  if(!Number.isSafeInteger(board.revision))throw Error('Group revision overflow.');
  state.groupGovernance=board;
  event(state,context.role,'group-governance.'+op,null,body.group,
    {account:context.account,kind:kind??null,target:body.target??null,revision:board.revision});
  return operatorView(state,context);
}

module.exports={provision,list,operatorView,change};
