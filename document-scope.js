'use strict';
const {createHash,randomUUID}=require('node:crypto');
const identity=require('./identity-admin');
const documents=require('./governance-documents');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const slug=/^[a-z][a-z0-9-]{0,47}$/;
const hash=/^[a-f0-9]{64}$/;
const modes=['text','text-and-attachments'];
const reasons=['operational-need','correction','assignment-ended','scope-review'];
const duration=30*86400000, limit=500;
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const missing=()=>fail(404,'RECORD_NOT_FOUND','That document revision was not found.');
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const exact=(data,keys)=>data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===keys.length&&keys.every(k=>Object.hasOwn(data,k));
const stamp=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex');

function provision(isolated){
  if(isolated?.documentScopeWorkspaces===undefined)return new Set();
  const ids=isolated.documentScopeWorkspaces;
  if(isolated.enableIdentityAdmin!==true||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||
    !Array.isArray(isolated.accounts)||!Array.isArray(isolated.workspaces))
    throw Error('Document access scope needs identity administration and explicit isolated workspaces.');
  for(const id of ids){
    if(!isolated.workspaces.some(w=>w.id===id))throw Error('Document access scope names an unknown workspace.');
    const seats=new Map(isolated.accounts.filter(a=>Object.hasOwn(a.memberships??{},id)).map(a=>[a.memberships[id],a.id]));
    if(!seats.has('identity-admin')||!seats.has('reviewer')||!seats.has('case-operator')||new Set([
      seats.get('identity-admin'),seats.get('reviewer'),seats.get('case-operator')
    ]).size!==3)throw Error('Document scope requires distinct identity admin, reviewer and case-operator accounts.');
  }
  return new Set(ids);
}

function records(state){
  const board=state.documentAccessScope;
  if(board===undefined)return {version:1,revision:0,grants:[]};
  const bad=()=>{throw Error('Invalid document access scope state.');};
  if(board?.version!==1||!Number.isSafeInteger(board.revision)||board.revision<0||
    !Array.isArray(board.grants)||board.grants.length>limit)bad();
  const seenIds=new Set(), currentTargets=new Set();
  for(const g of board.grants){
    if(!g||![g.id,g.document,g.edition].every(x=>matches(uuid,x))||seenIds.has(g.id)||
      ![g.account,g.proposedBy].every(x=>matches(slug,x))||!matches(hash,g.binding)||!modes.includes(g.level)||
      !['pending','approved','rejected','revoked'].includes(g.status))bad();
    if(g.status==='approved'&&(!Number.isSafeInteger(g.expiresAt)||g.expiresAt<1||!matches(slug,g.decidedBy)||g.decidedBy===g.proposedBy))bad();
    if(['pending','approved'].includes(g.status)){
      const key=g.account+':'+g.document+':'+g.edition;
      if(currentTargets.has(key))bad();
      currentTargets.add(key);
    }
    seenIds.add(g.id);
  }
  return board;
}
function activeSeat(state,seat,at){
  return seat&&!seat.configuredDisabled&&(seat.validUntil===null||at<seat.validUntil)&&!identity.record(state,seat.id).disabled;
}
function authority(state,ctx,roles){
  const current=ctx.roster.find(s=>s.id===ctx.account&&s.role===ctx.role);
  if(!activeSeat(state,current,ctx.at)||identity.record(state,ctx.account).revision!==ctx.generation)
    fail(401,'SESSION_INACTIVE','Sign in to a local workspace.');
  if(!roles.includes(current.role))fail(403,'DOCUMENT_SCOPE_AUTHORITY','Your role cannot perform this document access action.');
}
function seatBinding(state,ctx,id){
  const seat=ctx.roster.find(s=>s.id===id&&s.role==='case-operator');
  if(!activeSeat(state,seat,ctx.at))return undefined;
  return stamp([seat.id,seat.provisioning,identity.record(state,id).revision]);
}
// The domain's ordinary role, publication and linked-case ownership gates are always additive.
function baseModel(state){return documents.view(state,'case-operator');}
function entry(model,document,edition){
  const doc=model.documents.find(x=>x.id===document);
  const rev=doc?.revisions.find(x=>x.id===edition&&x.status==='published');
  return rev?{doc,rev}:undefined;
}
function binding(state,ctx,g,model){
  const seat=seatBinding(state,ctx,g.account),edition=entry(model,g.document,g.edition)?.rev;
  if(!seat||!edition)return undefined;
  const ownershipEpochs=edition.links.filter(link=>link.type==='rights-case').map(link=>[
    link.id,state.audit.findLast(row=>row.entityId===link.id&&row.action==='rights.case.assign')?.id??null
  ]);
  return stamp([seat,g.document,g.edition,edition.contentHash,g.level,ownershipEpochs,
    edition.attachments.map(a=>[a.id,a.sha256,a.name,a.size,a.mediaType])]);
}
function effective(state,ctx,g,model){
  if(!['approved','pending'].includes(g.status))return g.status;
  if(binding(state,ctx,g,model)!==g.binding)return 'stale';
  if(g.status==='approved'&&ctx.at>=g.expiresAt)return 'expired';
  return g.status;
}
function boardView(state,ctx){
  authority(state,ctx,['reviewer','identity-admin']);
  const board=records(state),model=baseModel(state);
  const grants=board.grants.map(g=>{
    const version=entry(model,g.document,g.edition);
    return {id:g.id,account:g.account,document:g.document,edition:g.edition,level:g.level,
      status:effective(state,ctx,g,model),proposedBy:g.proposedBy,decidedBy:g.decidedBy,
      expiresAt:g.expiresAt,kind:version?.doc.kind,number:version?.rev.number,
      ...(ctx.role==='reviewer'&&version?{title:version.rev.title}:{})};
  }).reverse();
  const audit=state.audit.filter(row=>row.action.startsWith('document-scope.')).slice(-40).reverse()
    .map(row=>({at:row.at,actor:row.account,action:row.action.slice(15),id:row.entityId,...row.details}));
  return {role:ctx.role,revision:board.revision,grants,audit,
    ...(ctx.role==='reviewer'?{
      eligibleAccounts:ctx.roster.filter(s=>s.role==='case-operator'&&activeSeat(state,s,ctx.at)).map(s=>s.id),
      editions:model.documents.flatMap(d=>d.revisions.filter(r=>r.status==='published')
        .map(r=>({document:d.id,id:r.id,number:r.number,title:r.title})))
    }:{})};
}
function transition(state,ctx,body,event){
  const op=body?.operation,propose=op==='propose';
  authority(state,ctx,propose?['reviewer']:['identity-admin']);
  if(!['propose','approve','reject','revoke'].includes(op)||
    !exact(body,propose?['operation','account','document','edition','level','expectedRevision','reason']:['operation','grant','expectedRevision','reason'])||
    !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!reasons.includes(body.reason)||
    (propose?(!matches(slug,body.account)||!matches(uuid,body.document)||!matches(uuid,body.edition)||!modes.includes(body.level)):!matches(uuid,body.grant)))
    fail(422,'INVALID_DOCUMENT_SCOPE','Choose an exact document edition, access level, account and decision reason.');
  const board=records(state);
  if(board.revision!==body.expectedRevision)fail(409,'STALE_DOCUMENT_SCOPE','Document access changed. Reload the board.');
  const model=baseModel(state);
  let grant;
  if(propose){
    const check=binding(state,ctx,body,model);
    if(!check)missing();
    if(board.grants.length>=limit)fail(409,'DOCUMENT_SCOPE_LIMIT','This workspace has reached its local grant history limit.');
    for(const row of board.grants){
      if(row.account!==body.account||row.document!==body.document||row.edition!==body.edition||
        !['pending','approved'].includes(row.status))continue;
      if(['pending','approved'].includes(effective(state,ctx,row,model)))
        fail(409,'DOCUMENT_SCOPE_EXISTS','That account already has a current proposal or grant for this edition. Revoke it before requesting another.');
      row.status='revoked';
      event(state,'document-scope.replaced',row,{reason:'scope-review',revision:board.revision+1});
    }
    grant={id:randomUUID(),account:body.account,document:body.document,edition:body.edition,level:body.level,
      binding:check,proposedBy:ctx.account,status:'pending'};
    board.grants.push(grant);
  }else{
    grant=board.grants.find(g=>g.id===body.grant);
    if(!grant)fail(404,'GRANT_NOT_FOUND','That document access request was not found.');
    if(grant.proposedBy===ctx.account)fail(403,'INDEPENDENT_DOCUMENT_SCOPE','Another account must decide this request.');
    if(op==='approve'&&effective(state,ctx,grant,model)!=='pending')
      fail(409,'DOCUMENT_SCOPE_STALE','That request is no longer pending and eligible.');
    if(op==='reject'&&grant.status!=='pending'||op==='revoke'&&!['approved','pending'].includes(grant.status))
      fail(409,'DOCUMENT_SCOPE_UNAVAILABLE','That decision is not available for this request.');
    grant.status=({approve:'approved',reject:'rejected',revoke:'revoked'})[op];
    if(op==='approve'){
      grant.expiresAt=ctx.at+duration;
      if(!Number.isSafeInteger(grant.expiresAt))throw Error('Invalid document scope expiry.');
    }
    grant.decidedBy=ctx.account;
  }
  board.revision++;
  if(!Number.isSafeInteger(board.revision))throw Error('Document scope revision overflow.');
  state.documentAccessScope=board;
  event(state,'document-scope.'+op,grant,{reason:body.reason,revision:board.revision});
  return boardView(state,ctx);
}
function allowed(state,ctx,model){
  authority(state,ctx,['case-operator']);
  return new Map(records(state).grants.filter(g=>g.account===ctx.account&&effective(state,ctx,g,model)==='approved')
    .map(g=>[g.document+':'+g.edition,g.level]));
}
function list(state,ctx){
  const model=baseModel(state),grants=allowed(state,ctx,model);
  return {...model,documents:model.documents.flatMap(d=>{
    const revisions=d.revisions.filter(r=>grants.has(d.id+':'+r.id)).map(r=>project(r,grants.get(d.id+':'+r.id)));
    return revisions.length?[{...d,currentRevisionId:revisions.at(-1).id,revisions}]:[];
  })};
}
function authorize(state,ctx,document,edition,attachment){
  const level=allowed(state,ctx,baseModel(state)).get(document+':'+edition);
  if(!level||(attachment&&level!=='text-and-attachments'))missing();
  return level;
}
function project(version,level){
  return {...version,attachments:level==='text-and-attachments'?version.attachments:[]};
}
module.exports={provision,boardView,transition,list,authorize,project,missing};
