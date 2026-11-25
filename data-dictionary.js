'use strict';
const {randomUUID}=require('node:crypto');
const slugPattern=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const types=Object.freeze({
  sensitivity:{label:'Sensitivity',nodeTypes:['dataset']},
  purpose:{label:'Processing purpose',nodeTypes:['activity']},
  domain:{label:'Data domain',nodeTypes:['system','dataset','activity']},
});
const blank=()=>({revision:0,terms:[],references:[]});
const book=s=>s.dictionary??blank();
const map=s=>s.dataMap??{revision:0,nodes:[],links:[]};
const reject=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const has=(obj,key)=>typeof key==='string'&&Object.hasOwn(obj,key);
function text(value,max,name){
  if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))
    reject(422,'TERM_TEXT','Provide fictional '+name+' of 1 to '+max+' characters.');
  return value.trim();
}
function only(body,keys){
  if(Object.keys(body).length!==keys.length||!keys.every(k=>Object.hasOwn(body,k)))reject(422,'DICTIONARY_FIELDS','Provide only the required fields.');
}
const consumers=(s,id)=>book(s).references.filter(x=>x.termId===id);
const hasNodeReferences=(s,id)=>book(s).references.some(x=>x.nodeId===id);
function mapProjection(s){
  const dictionary=book(s),terms=new Map(dictionary.terms.map(t=>[t.id,t])),byNode=new Map();
  for(const ref of dictionary.references){
    const term=terms.get(ref.termId),version=term.versions.find(v=>v.number===ref.version);
    if(!byNode.has(ref.nodeId))byNode.set(ref.nodeId,[]);
    byNode.get(ref.nodeId).push({slug:term.slug,type:term.type,version:version.number,title:version.title});
  }
  return byNode;
}
function view(s){
  const d=book(s),m=map(s),owners=new Map(m.nodes.map(n=>[n.id,n]));
  return {revision:d.revision,mapRevision:m.revision,types,
    terms:d.terms.map(t=>({...t,consumers:consumers(s,t.id).map(ref=>({...ref,nodeName:owners.get(ref.nodeId)?.name??'Unavailable'}))})),
    inventory:m.nodes.filter(n=>!n.archivedAt).map(n=>({id:n.id,name:n.name,type:n.type}))};
}
function change(s,parts,role,body,event){
  const [,group,id,action]=parts,d=book(s),m=map(s);
  const create=group==='terms'&&parts.length===2;
  const operation=create?'create':action;
  if(!create&&!(parts.length===4&&group==='terms'&&['revise','submit','approve','return','retire','attach','detach'].includes(action)))
    reject(404,'DICTIONARY_ROUTE','Dictionary action not found.');
  let term=d.terms.find(t=>t.id===id),version;
  const emit=(act,detail)=>event(s,role,'dictionary.'+act,null,term?.id??null,{...detail,revision:d.revision,mapRevision:m.revision});
  try{
    const reviewer=['approve','return'].includes(action);
    if(role!==(reviewer?'reviewer':'analyst'))reject(403,'DICTIONARY_ROLE','This dictionary action requires the assigned role.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==d.revision)
      reject(409,'DICTIONARY_STALE','The dictionary changed. Reload before retrying.');
    if(!create&&!term)reject(404,'TERM_NOT_FOUND','Term not found in this workspace.');
    if(term?.retiredAt)reject(409,'TERM_RETIRED','A retired term is read-only.');
    const now=new Date().toISOString();
    let detail;
    if(create||action==='revise'){
      only(body,['expectedRevision','title','definition',...(create?['slug','type']:[])]);
      if(create){
        if(typeof body.slug!=='string'||body.slug.length>60||!slugPattern.test(body.slug))reject(422,'TERM_SLUG','Use a stable lowercase slug.');
        if(d.terms.some(t=>t.slug===body.slug))reject(409,'TERM_DUPLICATE','That slug has already been assigned.');
        if(!has(types,body.type))reject(422,'TERM_TYPE','Choose a supported term type.');
        if(d.terms.length>=300)reject(409,'DICTIONARY_LIMIT','The local term limit has been reached.');
        term={id:randomUUID(),slug:body.slug,type:body.type,activeVersion:null,retiredAt:null,versions:[]};
      }else if(['draft','review'].includes(term.versions.at(-1).status))reject(409,'TERM_PENDING','Resolve the pending version before revising.');
      if(term.versions.length>=100)reject(409,'TERM_VERSION_LIMIT','The local version limit has been reached.');
      version={number:term.versions.length+1,title:text(body.title,120,'title'),definition:text(body.definition,1200,'definition'),
        status:'draft',createdAt:now,review:null};
      term.versions.push(version);
      if(create)d.terms.push(term);
      detail={version:version.number};
    }else if(action==='attach'||action==='detach'){
      only(body,['expectedRevision','expectedMapRevision','nodeId','version']);
      if(!Number.isSafeInteger(body.expectedMapRevision)||body.expectedMapRevision!==m.revision)
        reject(409,'DICTIONARY_MAP_STALE','The inventory changed. Reload before retrying.');
      const node=m.nodes.find(n=>n.id===body.nodeId&&!n.archivedAt);
      if(!node)reject(404,'CONSUMER_NOT_FOUND','Select an active node from this workspace.');
      const existing=d.references.find(x=>x.nodeId===node.id&&x.termId===term.id);
      if(action==='attach'){
        if(!types[term.type].nodeTypes.includes(node.type))reject(422,'CONSUMER_TYPE','This term type does not apply to that inventory record.');
        if(body.version!==term.activeVersion||!term.versions.some(v=>v.number===body.version&&v.status==='approved'))
          reject(409,'TERM_VERSION_REQUIRED','New references require the currently approved version.');
        if(existing)reject(409,'CONSUMER_ALREADY_PINNED','Detach the existing pin explicitly before assigning another version.');
        if(d.references.length>=3000)reject(409,'DICTIONARY_LIMIT','The local reference limit has been reached.');
        d.references.push({termId:term.id,nodeId:node.id,version:body.version,attachedAt:now});
      }else{
        if(!existing||existing.version!==body.version)reject(409,'TERM_PIN_MISMATCH','Detach the exact pinned version.');
        d.references=d.references.filter(x=>x!==existing);
      }
      m.revision++;
      detail={nodeId:node.id,version:body.version};
    }else if(action==='retire'){
      only(body,['expectedRevision','reason']);
      if(consumers(s,term.id).length)reject(409,'TERM_IN_USE','Remove all active consumer references before retiring the term.');
      if(['draft','review'].includes(term.versions.at(-1).status))reject(409,'TERM_PENDING','Resolve the pending version before retiring.');
      detail={reason:text(body.reason,300,'retirement rationale'),lastApprovedVersion:term.activeVersion};
      term.retiredAt=now;
    }else{
      only(body,['expectedRevision','version',...(action==='return'?['reason']:[])]);
      version=term.versions.at(-1);
      if(version.number!==body.version)reject(409,'TERM_WRONG_VERSION','Choose the exact pending version.');
      if(version.status!==(action==='submit'?'draft':'review'))reject(409,'TERM_WRONG_STAGE','That action is unavailable for this version.');
      if(action==='submit')version.status='review';
      else{
        version.review={decision:action,at:now,...(action==='return'?{reason:text(body.reason,300,'return rationale')}:{})};
        version.status=action==='approve'?'approved':'returned';
        if(action==='approve')term.activeVersion=version.number;
      }
      detail={version:version.number};
    }
    d.revision++;
    s.dictionary=d;
    emit(operation,detail);
  }catch(error){
    if(error.status){
      emit('refused',{operation,code:error.code});
      error.persistRefusal=true;
    }
    throw error;
  }
}
module.exports={view,change,hasNodeReferences,mapProjection};
