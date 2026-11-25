'use strict';
const {createHash}=require('node:crypto');
const catalog=Object.freeze({
  privacy:Object.freeze({label:'Privacy practices',options:Object.freeze({
    overview:'This fictional service keeps a local inventory of the information used by its sample operations.',
    review:'Changes to fictional information handling are documented and reviewed in the sample workbench.',
  })}),
  rights:Object.freeze({label:'Privacy requests',options:Object.freeze({
    overview:'The sample requester portal lets a provisioned test user submit and track one fictional request.',
    review:'In the sample workflow, a reviewer and a designated owner handle different stages. No real information is released.',
  })}),
  controls:Object.freeze({label:'Controls and assurance',options:Object.freeze({
    overview:'Fictional control tests in the workbench require recorded evidence and a separate review.',
    review:'The demo records local control decisions. It does not offer a certification or report on a live service.',
  })}),
});
const has=(x,k)=>typeof k==='string'&&Object.hasOwn(x,k);
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const empty=()=>({revision:0,topics:{}});
const model=state=>state.trustCenter??empty();
const digest=card=>createHash('sha256').update(JSON.stringify(card)).digest('hex');
function visitor(state){
  const cards=[];
  for(const id of Object.keys(catalog)){
    const topic=model(state).topics[id];
    if(!topic?.activeVersion)continue;
    const active=topic.versions.find(v=>v.version===topic.activeVersion);
    if(active?.status!=='published'||active.hash!==digest(active.card))continue;
    cards.push({heading:active.card.heading,description:active.card.description});
  }
  return {title:'Synthetic trust center',cards};
}
function view(state,visitorPath){
  return {enabled:!!visitorPath,...(visitorPath?{visitorPath,catalog,...model(state)}:{})};
}
function change(state,parts,actor,body,event){
  const [,topic,action]=parts;
  if(parts.length!==3||!has(catalog,topic)||!['draft','submit','approve','return','publish','withdraw'].includes(action))
    fail(404,'CENTER_NOT_FOUND','Trust center action not found.');
  const center=state.trustCenter??empty();
  const row=center.topics[topic]??{activeVersion:null,versions:[]};
  let v=row.versions.at(-1);
  const record=(name,details)=>event(state,actor,'trust-center.'+name,null,null,{topic,...details,revision:center.revision});
  try{
    const reviewer=['approve','return'].includes(action);
    if(actor!==(reviewer?'reviewer':'analyst'))fail(403,'CENTER_ROLE_REQUIRED','This action requires the assigned independent role.');
    const allowed=action==='draft'?['expectedRevision','option']:['expectedRevision','version',...(['return','withdraw'].includes(action)?['note']:[])];
    if(Object.keys(body).length!==allowed.length||!allowed.every(k=>Object.hasOwn(body,k)))fail(422,'CENTER_FIELDS','Provide only the required fields.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==center.revision)fail(409,'CENTER_STALE','The trust center changed. Reload before retrying.');
    const now=new Date().toISOString();
    if(action==='draft'){
      if(v&&['draft','in-review','approved'].includes(v.status))fail(409,'CENTER_PENDING','Resolve the current version before starting another draft.');
      if(!has(catalog[topic].options,body.option))fail(422,'CENTER_COPY','Select bundled fictional copy; free text is not public-facing.');
      if(row.versions.length>=100)fail(409,'CENTER_LIMIT','The local version limit has been reached.');
      const card={heading:catalog[topic].label,description:catalog[topic].options[body.option]};
      v={version:(v?.version??0)+1,option:body.option,card,hash:digest(card),status:'draft',createdAt:now,review:null};
      row.versions.push(v);
    }else{
      if(!Number.isSafeInteger(body.version))fail(422,'CENTER_VERSION','Provide the exact version.');
      if(action==='withdraw')v=row.versions.find(x=>x.version===row.activeVersion);
      if(!v||v.version!==body.version)fail(409,'CENTER_WRONG_VERSION','This is not the current eligible version.');
      if(v.hash!==digest(v.card))throw Error('Trust center snapshot integrity check failed.');
      const needed={submit:'draft',approve:'in-review',return:'in-review',publish:'approved',withdraw:'published'};
      if(v.status!==needed[action])fail(409,'CENTER_WRONG_STAGE','The selected version is not at the required stage.');
      let note;
      if(['return','withdraw'].includes(action)){
        if(typeof body.note!=='string'||!body.note.trim()||body.note.length>300)fail(422,'CENTER_NOTE','Provide a fictional internal note of up to 300 characters.');
        note=body.note.trim();
      }
      if(action==='submit')v.status='in-review';
      if(reviewer){
        v.review={decision:action,at:now,...(note?{note}:{})};
        v.status=action==='approve'?'approved':'returned';
      }
      if(action==='publish'){
        if(v.review?.decision!=='approve')fail(409,'CENTER_NO_APPROVAL','This exact version must be independently approved.');
        const old=row.versions.find(x=>x.version===row.activeVersion);
        if(old)old.status='superseded';
        v.status='published';v.publishedAt=now;row.activeVersion=v.version;
      }
      if(action==='withdraw'){v.status='withdrawn';v.withdrawnAt=now;row.activeVersion=null;}
      v.updatedAt=now;
      center.revision++;
      center.topics[topic]=row;
      state.trustCenter=center;
      record(action,{version:v.version,hash:v.hash,status:v.status,...(action==='withdraw'?{note}:{})});
      return;
    }
    center.revision++;
    center.topics[topic]=row;
    state.trustCenter=center;
    record(action,{version:v.version,hash:v.hash,status:v.status});
  }catch(error){
    if(error.status){
      record('refused',{action,code:error.code});
      error.persistRefusal=true;
    }
    throw error;
  }
}
function provision(entries,workspaces){
  if(!Array.isArray(entries)||entries.length>32)throw Error('Invalid synthetic trust center provisioning.');
  const known=new Set(workspaces.map(x=>x.id)),bySlug=new Map(),byWorkspace=new Map();
  for(const {slug,workspace} of entries){
    if(typeof slug!=='string'||!/^sample-[a-z0-9-]{1,32}$/.test(slug)||!known.has(workspace)||bySlug.has(slug)||byWorkspace.has(workspace))
      throw Error('Invalid synthetic trust center site.');
    bySlug.set(slug,workspace);byWorkspace.set(workspace,slug);
  }
  return {workspace:slug=>bySlug.get(slug),path:workspace=>byWorkspace.has(workspace)?'/trust-center/'+byWorkspace.get(workspace):null};
}
module.exports={provision,visitor,view,change};
