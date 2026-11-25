'use strict';

const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {TextDecoder}=require('node:util');
const {openSqlite,publishNew,restoreDocuments}=require('./durable-storage');
const {linkTypes}=require('./data-map').view({});
const {types:termTypes}=require('./data-dictionary').view({});
const {backupActor}=require('./rights-workflow');

const format='mvw-trust-fictional-transfer';
const planFormat='mvw-trust-fictional-transfer-plan';
const receiptFormat='mvw-trust-fictional-transfer-receipt';
const maxBytes=512*1024;
const workspacePattern=/^migration-[a-z0-9][a-z0-9-]{0,31}$/;
const idPattern=/^fixture-[0-9]{4}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const nodeTypes=new Set(['system','dataset','activity']);
const owners={'studio':'Fictional Studio','operations':'Fictional Operations','quality':'Fictional Quality'};
const profiles={
  system:{archive:'Fictional archive sandbox.',service:'Fictional service sandbox.'},
  dataset:{signals:'Fictional signal schema; no sample values.',events:'Fictional event schema; no sample values.'},
  activity:{quality:'Fictional quality exercise.',rehearsal:'Fictional workflow rehearsal.'},
};
const definitions={
  purpose:'Fictional processing purpose for an isolated migration exercise.',
  sensitivity:'Fictional sensitivity category for an isolated migration exercise.',
  domain:'Fictional inventory classification for an isolated migration exercise.',
};
const linkPurpose={
  hosts:'Fictional service hosts a fixture dataset.',reads:'Fictional activity reads a fixture dataset.',
  writes:'Fictional activity produces a fixture dataset.',transfers:'Fictional fixture material moves between test components.',
};
const roles=()=>[{id:'analyst',name:'Migration Analyst (fictional)',role:'analyst'},
  {id:'reviewer',name:'Migration Reviewer (fictional)',role:'reviewer'},{...backupActor}];
const blankState=()=>({version:1,actors:roles(),projects:[],vendors:[],assessments:[],handoff:[],audit:[]});
const exact=(x,keys)=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const is=(regex,value)=>typeof value==='string'&&value.trim()===value&&regex.test(value);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
const fixtureEpoch='2000-01-01T00:00:00.000Z';
function reject(message){throw new Error(message);}
function assertWorld(workspace){
  if(!is(workspacePattern,workspace))reject('Target workspace must begin with migration- and use a synthetic local slug.');
}
function stableId(packageId,kind,key){
  const bits=sha([format,1,packageId,kind,key]).slice(0,32).split('');
  bits[12]='8';bits[16]='8';
  const bytes=bits.join('');
  return [bytes.slice(0,8),bytes.slice(8,12),bytes.slice(12,16),bytes.slice(16,20),bytes.slice(20)].join('-');
}

function readBounded(file){
  let descriptor;
  try{
    // lstat also rejects links on platforms without O_NOFOLLOW.
    const info=fs.lstatSync(file);
    if(!info.isFile()||info.nlink!==1||info.size>maxBytes)reject('Expected a single-link local JSON file of at most 512 KiB.');
    descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
    const actual=fs.fstatSync(descriptor);
    if(!actual.isFile()||actual.nlink!==1||actual.size>maxBytes||actual.dev!==info.dev||actual.ino!==info.ino)
      reject('Input changed while opening the local JSON file.');
    const bytes=Buffer.alloc(maxBytes+1);
    let length=0;
    for(let n;n=fs.readSync(descriptor,bytes,length,bytes.length-length,null);){
      length+=n;
      if(length>maxBytes)reject('Expected a single-link local JSON file of at most 512 KiB.');
    }
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
  }finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}
function parse(file){
  const raw=readBounded(file);
  let value;
  try{value=JSON.parse(raw);}catch{reject('Input must be valid JSON.');}
  // JSON.parse accepts duplicate object members silently; that is unsafe for a
  // reviewed interchange format. Scan already-validated syntax, not values.
  const stack=[];
  for(const [token] of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/gs)){
    const top=stack.at(-1);
    if(token==='{')stack.push({keys:new Set(),nextKey:true});
    else if(token==='[')stack.push({});
    else if(token==='}'||token===']')stack.pop();
    else if(token===','&&top?.keys)top.nextKey=true;
    else if(token[0]==='"'&&top?.nextKey){
      const key=JSON.parse(token);
      if(top.keys.has(key))reject('Duplicate JSON object member.');
      top.keys.add(key);top.nextKey=false;
    }
  }
  return value;
}
function collect(rows,cap,label,normalize){
  if(!Array.isArray(rows)||rows.length>cap)reject(label+' collection exceeds its bounded count or is missing.');
  const seen=new Map();
  let duplicates=0;
  for(const [i,row] of rows.entries()){
    const {key,value}=normalize(row,i+1);
    if(seen.has(key)){
      if(JSON.stringify(seen.get(key))!==JSON.stringify(value))reject(label+' row '+(i+1)+' conflicts with an earlier fixture key.');
      duplicates++;
    }else seen.set(key,value);
  }
  return {rows:[...seen.values()].sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b))),duplicates};
}
function ensureAcyclic(nodes,edges){
  const outgoing=new Map(nodes.map(n=>[n.key,[]])),incoming=new Map(nodes.map(n=>[n.key,0]));
  for(const {from,to} of edges){
    outgoing.get(from).push(to);
    incoming.set(to,incoming.get(to)+1);
  }
  const ready=nodes.filter(n=>incoming.get(n.key)===0).map(n=>n.key);
  for(let i=0;i<ready.length;i++){
    for(const destination of outgoing.get(ready[i])){
      const remaining=incoming.get(destination)-1;
      incoming.set(destination,remaining);
      if(remaining===0)ready.push(destination);
    }
  }
  if(ready.length!==nodes.length)reject('Inventory relationships contain a directed cycle.');
}
function stage(source,workspace){
  assertWorld(workspace);
  if(!exact(source,['format','version','packageId','inventories','relationships','terms','termBindings'])||
    source.format!==format||source.version!==1||!is(idPattern,source.packageId))
    reject('Expected the original fictional transfer v1 envelope. No credentials, files, text, or proprietary formats are accepted.');
  const {packageId}=source;
  const inventories=collect(source.inventories,100,'Inventory',(row,i)=>{
    if(!exact(row,['key','kind','owner','profile'])||!is(/^n[0-9]{4}$/,row.key)||!nodeTypes.has(row.kind)||
      typeof row.owner!=='string'||!Object.hasOwn(owners,row.owner)||typeof row.profile!=='string'||!Object.hasOwn(profiles[row.kind],row.profile))
      reject('Inventory row '+i+' has an unsupported field or fixture enum.');
    return {key:row.key,value:{key:row.key,kind:row.kind,owner:row.owner,profile:row.profile}};
  });
  if(!inventories.rows.length)reject('Include at least one fictional inventory item.');
  const byNode=new Map(inventories.rows.map(row=>[row.key,row]));
  const relationships=collect(source.relationships,250,'Relationship',(row,i)=>{
    if(!exact(row,['key','kind','from','to'])||!is(/^l[0-9]{4}$/,row.key)||typeof row.kind!=='string'||!Object.hasOwn(linkTypes,row.kind))
      reject('Relationship row '+i+' has an unsupported field or fixture enum.');
    const rule=linkTypes[row.kind],from=byNode.get(row.from),to=byNode.get(row.to);
    if(!from||!to)reject('Relationship row '+i+' has an unresolved inventory reference.');
    if(row.from===row.to||!rule.from.includes(from.kind)||!rule.to.includes(to.kind))
      reject('Relationship row '+i+' is incompatible with the inventory endpoint types.');
    const value={key:row.key,kind:row.kind,from:row.from,to:row.to};
    return {key:row.key,value};
  });
  const uniqueRelationships=[],aliases=[],signatureByKey=new Map();
  const semantic=new Map();
  for(const row of relationships.rows){
    const key=JSON.stringify([row.kind,row.from,row.to]);
    signatureByKey.set(row.key,key);
    const prior=semantic.get(key);
    if(prior)aliases.push({alias:row.key,target:prior.key});
    else {semantic.set(key,row);uniqueRelationships.push(row);}
  }
  ensureAcyclic(inventories.rows,uniqueRelationships);

  const terms=collect(source.terms,40,'Dictionary term',(row,i)=>{
    if(!exact(row,['key','kind'])||!is(/^t[0-9]{4}$/,row.key)||typeof row.kind!=='string'||!Object.hasOwn(termTypes,row.kind))
      reject('Dictionary term row '+i+' has an unsupported field or fixture enum.');
    return {key:row.key,value:{key:row.key,kind:row.kind}};
  });
  const byTerm=new Map(terms.rows.map(row=>[row.key,row]));
  const termBindings=collect(source.termBindings,100,'Dictionary binding',(row,i)=>{
    if(!exact(row,['term','node']))reject('Dictionary binding row '+i+' has an unsupported field.');
    const term=byTerm.get(row.term),node=byNode.get(row.node);
    if(!term||!node)reject('Dictionary binding row '+i+' has an unresolved inventory or term reference.');
    if(!termTypes[term.kind].nodeTypes.includes(node.kind))reject('Dictionary binding row '+i+' is incompatible with the inventory endpoint type.');
    return {key:JSON.stringify([row.term,row.node]),value:{term:row.term,node:row.node}};
  });

  const nodeId=key=>stableId(packageId,'inventory',key);
  const termId=key=>stableId(packageId,'term',key);
  const linkId=key=>stableId(packageId,'relationship',signatureByKey.get(key));
  const canonicalSource={packageId,inventories,relationships,terms,termBindings};
  const body={format:planFormat,version:1,packageId,workspace,packageDigest:sha(canonicalSource),
    stages:[
      {name:'inventory',outcome:'create',count:inventories.rows.length,duplicates:inventories.duplicates},
      {name:'relationships',outcome:'create',count:uniqueRelationships.length,duplicates:relationships.duplicates+aliases.length},
      {name:'terms',outcome:'draft-only',count:terms.rows.length,duplicates:terms.duplicates},
      {name:'termBindings',outcome:'deferred-independent-approval',count:termBindings.rows.length,duplicates:termBindings.duplicates},
    ],
    map:{
      nodes:inventories.rows.map(({key,kind,owner,profile})=>({key,id:nodeId(key),type:kind,
        name:'Fictional '+kind+' '+key.slice(1),owner:owners[owner],detail:profiles[kind][profile]})),
      links:uniqueRelationships.map(({key,kind,from,to})=>({key,id:linkId(key),type:kind,fromId:nodeId(from),toId:nodeId(to),note:linkPurpose[kind]})),
      linkAliases:aliases.map(({alias,target})=>({key:alias,canonicalKey:target,id:linkId(target)})),
    },
    terms:terms.rows.map(({key,kind})=>({key,id:termId(key),type:kind,slug:'migration-'+packageId+'-'+key,
      title:'Fictional '+kind+' term '+key.slice(1),definition:definitions[kind]})),
    deferredBindings:termBindings.rows.map(({node,term})=>({nodeId:nodeId(node),termId:termId(term),requires:'independent-dictionary-approval'})),
  };
  return {...body,planDigest:sha(body)};
}
function writePlan(source,workspace,output){
  const result=stage(parse(source),workspace);
  publishNew(output,temp=>fs.writeFileSync(temp,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600,flush:true}));
  return result;
}
const withoutKey=({key,...row})=>row;
function importFixture(source,planFile,database,confirmation){
  if(!is(digestPattern,confirmation))reject('Explicit confirmation must match the reviewed plan digest.');
  const candidate=parse(planFile);
  const plan=stage(parse(source),candidate?.workspace);
  if(confirmation!==plan.planDigest||JSON.stringify(candidate)!==JSON.stringify(plan))
    reject('The saved plan or source differs from the reviewed plan. Generate and review a fresh dry run.');
  const unsigned=blankState();
  unsigned.dataMap={revision:1,
    nodes:plan.map.nodes.map(row=>({...withoutKey(row),createdAt:fixtureEpoch,updatedAt:fixtureEpoch,archivedAt:null})),
    links:plan.map.links.map(row=>({...withoutKey(row),createdAt:fixtureEpoch,archivedAt:null}))};
  unsigned.dictionary={revision:plan.terms.length?1:0,references:[],terms:plan.terms.map(({key,title,definition,...row})=>({...row,
    activeVersion:null,retiredAt:null,versions:[{number:1,title,definition,status:'draft',createdAt:fixtureEpoch,review:null}]}))};
  const counts=Object.fromEntries(plan.stages.map(stage=>[stage.name,stage.count]));
  const importedAt=new Date().toISOString();
  unsigned.audit=[{id:stableId(plan.packageId,'audit',plan.planDigest),sequence:1,at:importedAt,actor:'local-fixture-migration',
    action:'migration.fixture-imported',projectId:null,entityId:null,details:{planDigest:plan.planDigest,...counts}}];
  const envelope={format:receiptFormat,version:1,packageId:plan.packageId,workspace:plan.workspace,
    planDigest:plan.planDigest,stages:plan.stages,importedAt,snapshotDigest:sha(unsigned)};
  const receipt={...envelope,receiptId:sha(envelope)};
  restoreDocuments('isolated',[{scope:'workspace:'+plan.workspace,kind:'workbench',generation:1,
    payload:{...unsigned,fixtureMigrationReceipt:receipt}}],database);
  return receipt;
}
function rollbackFixture(database,destination,confirmation){
  if(!is(digestPattern,confirmation))reject('Explicit rollback confirmation must match the import receipt ID.');
  const store=openSqlite(database,{readOnly:true});
  let mode,documents;
  try{({mode,documents}=store.snapshot());}finally{store.close();}
  const document=documents[0];
  if(mode!=='isolated'||documents.length!==1||document.kind!=='workbench'||document.generation!==1)
    reject('Rollback requires an untouched, dedicated fictional import database.');
  const {fixtureMigrationReceipt,...payload}=document.payload;
  if(!fixtureMigrationReceipt)reject('Rollback requires a fictional import receipt.');
  const {receiptId,...envelope}=fixtureMigrationReceipt;
  if(!exact(fixtureMigrationReceipt,['format','version','packageId','workspace','planDigest','stages','importedAt','snapshotDigest','receiptId'])||
    envelope.format!==receiptFormat||envelope.version!==1||receiptId!==confirmation||sha(envelope)!==receiptId||
    document.scope!=='workspace:'+envelope.workspace||sha(payload)!==envelope.snapshotDigest)
    reject('The import receipt or snapshot no longer matches. Rollback is unavailable.');
  assertWorld(envelope.workspace);
  const restored=blankState();
  restoreDocuments('isolated',[{scope:document.scope,kind:'workbench',generation:1,payload:restored}],destination);
  return {format:'mvw-trust-fictional-transfer-rollback',version:1,workspace:envelope.workspace,
    restoredFromReceipt:receiptId,sourceRetained:true,rollbackSnapshotDigest:sha(restored)};
}
module.exports={stage,writePlan,importFixture,rollbackFixture};
