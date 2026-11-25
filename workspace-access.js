'use strict';
const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');
const {resolve,join}=require('node:path');
const fs=require('node:fs');
const {capabilities}=require('./access-policy');
const ident=/^[a-z][a-z0-9-]{0,47}$/;
const codePattern=/^[A-Za-z0-9_-]{43}$/;
const roles=new Set(['analyst','reviewer','case-operator','publisher','ethics-investigator','ethics-reviewer']);
const digest=value=>createHash('sha256').update(value).digest();
const cookieName='trust_local_session';
const denied=(status,message)=>{throw Object.assign(new Error(message),{status})};
const cookie=(token='',age=0)=>cookieName+'='+token+'; Path=/; Max-Age='+age+'; HttpOnly; SameSite=Strict';

function createAccess({root,workspaces,accounts,sessionSeconds=1800,enableIdentityAdmin=false,now=Date.now},
  readIdentityRecord=()=>({revision:0,disabled:false}),workspaceFeatures=()=>({})){
  if(typeof root!=='string'||!root||!Number.isSafeInteger(sessionSeconds)||sessionSeconds<1||sessionSeconds>3600||
    typeof now!=='function'||typeof readIdentityRecord!=='function'||typeof enableIdentityAdmin!=='boolean'||!Array.isArray(workspaces)||!workspaces.length||!Array.isArray(accounts)||!accounts.length)
    throw new Error('Invalid isolated workspace configuration.');
  const spaces=new Map(), users=new Map(), seats=new Set(), keys=new Set(),sessions=new Map();
  const base=resolve(root);
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const resolvedRoot=fs.realpathSync(base);
  const safeFile=(folder,name)=>{
    const file=join(folder,name);
    try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1)throw new Error('Workspace store path is not a private regular file.');}
    catch(e){if(e.code!=='ENOENT')throw e}
    return file;
  };
  for(const {id,label} of workspaces){
    if(typeof id!=='string'||!ident.test(id)||spaces.has(id)||typeof label!=='string'||!label.trim()||label.length>120)throw new Error('Invalid isolated workspace.');
    const folder=join(resolvedRoot,id);
    try{fs.mkdirSync(folder,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}
    if(!fs.lstatSync(folder).isDirectory()||fs.realpathSync(folder)!==folder)throw new Error('Invalid workspace store directory.');
    spaces.set(id,{id,label,file:safeFile(folder,'state.json'),workflowFile:safeFile(folder,'workflows.json')});
  }
  for(const {id,codeHash,memberships,disabled=false,validUntil=null} of accounts){
    if(typeof id!=='string'||!ident.test(id)||users.has(id)||typeof codeHash!=='string'||!/^([0-9a-f]{64})$/.test(codeHash)||
      keys.has(codeHash)||typeof disabled!=='boolean'||(validUntil!==null&&(!Number.isSafeInteger(validUntil)||validUntil<1))||!memberships||typeof memberships!=='object'||Array.isArray(memberships)||!Object.keys(memberships).length)
      throw new Error('Invalid local synthetic account.');
    keys.add(codeHash);
    const grants=new Map();
    for(const [space,role] of Object.entries(memberships)){
      const seat=space+':'+role;
      if(!spaces.has(space)||(!roles.has(role)&&!(enableIdentityAdmin&&role==='identity-admin'))||seats.has(seat))throw new Error('Invalid or duplicated workspace role assignment.');
      seats.add(seat);grants.set(space,role);
    }
    users.set(id,{id,hash:Buffer.from(codeHash,'hex'),grants,disabled,validUntil});
  }
  const invalidHash=randomBytes(32);
  const live=(account,at)=>account&&!account.disabled&&(account.validUntil===null||at<account.validUntil);
  function tokenOf(req){
    const tokens=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
    return tokens.length===1&&codePattern.test(tokens[0].slice(cookieName.length+1))?tokens[0].slice(cookieName.length+1):null;
  }
  const membership=(workspace,id)=>readIdentityRecord(spaces.get(workspace),id);
  function currentGeneration(session){
    const record=membership(session.workspace,session.account.id);
    return !record.disabled&&record.revision===session.generation;
  }
  function lookup(req){
    const token=tokenOf(req),session=sessions.get(token);
    if(!session)return null;
    const at=now();
    if(at>=session.until||!live(session.account,at)||!currentGeneration(session)){sessions.delete(token);return null}
    return {...session,token};
  }
  function context(req,expected){
    const current=lookup(req);
    if(!current)denied(401,'Sign in to a local workspace.');
    if(expected.length!==1||expected[0]!==current.workspace)denied(403,'This request does not match the active workspace.');
    return {space:spaces.get(current.workspace),actor:current.account.grants.get(current.workspace),
      account:current.account.id,generation:current.generation};
  }
  const describe=session=>({mode:'local-isolated',authenticated:!!session,...(session?{
    account:session.account.id,actor:session.account.grants.get(session.workspace),workspace:session.workspace,
    capabilities:capabilities(session.account.grants.get(session.workspace),workspaceFeatures(session.workspace)),
    workspaces:[...session.account.grants].filter(([id])=>!membership(id,session.account.id).disabled).map(([id])=>({id,label:spaces.get(id).label}))
  }:{})});
  function issue(account,workspace,previous){
    const at=now();
    const until=Math.min(at+1000*sessionSeconds,account.validUntil??Infinity);
    if(!live(account,at))denied(401,'Invalid local sign-in.');
    const record=membership(workspace,account.id);
    if(record.disabled)denied(401,'Invalid local sign-in.');
    for(const [key,session] of sessions)
      if(session.until<=at||!live(session.account,at)||(session.account===account&&!currentGeneration(session)))sessions.delete(key);
    const count=[...sessions].filter(([key,s])=>key!==previous&&s.account===account).length;
    if(count>=8)denied(429,'Local account session limit reached.');
    if(sessions.size>=256&&!sessions.has(previous))denied(503,'Local session limit reached.');
    const token=randomBytes(32).toString('base64url'),session={account,workspace,until,generation:record.revision};
    if(previous)sessions.delete(previous);
    sessions.set(token,session);
    return {value:describe(session),cookie:cookie(token,Math.ceil((until-at)/1000))};
  }
  return {
    describe:req=>describe(lookup(req)),
    login(req,body){
      const account=typeof body?.account==='string'?users.get(body.account):null;
      const candidate=typeof body?.code==='string'&&codePattern.test(body.code)?digest(body.code):invalidHash;
      const matches=timingSafeEqual(account?.hash??invalidHash,candidate);
      if(!account||!matches||candidate===invalidHash||!account.grants.has(body.workspace)||!live(account,now()))denied(401,'Invalid local sign-in.');
      return issue(account,body.workspace,tokenOf(req));
    },
    switch(req,body){
      const current=lookup(req);
      if(!current)denied(401,'Sign in to a local workspace.');
      if(body?.current!==current.workspace||!current.account.grants.has(body.workspace)||membership(body.workspace,current.account.id).disabled)denied(403,'Workspace not available for this session.');
      return issue(current.account,body.workspace,current.token);
    },
    logout(req){sessions.delete(tokenOf(req));return {value:describe(null),cookie:cookie()}},
    identityRoster(id){
      return [...users.values()].filter(u=>u.grants.has(id)).map(u=>({
        id:u.id,role:u.grants.get(id),configuredDisabled:u.disabled,validUntil:u.validUntil,
        provisioning:digest(JSON.stringify([u.hash.toString('hex'),u.validUntil])).toString('hex')
      }));
    },
    identityTime:now,
    context,spaceForProvisionedGrant:id=>spaces.get(id)
  };
}
module.exports={createAccess,codeHash:code=>digest(code).toString('hex')};
