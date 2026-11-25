'use strict';
const {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual}=require('node:crypto');
const {fixtureOptions,getFixture}=require('./discovery-fixtures');
const ident=/^[a-z][a-z0-9-]{0,47}$/;
const column=/^[a-z][a-z0-9_]{0,47}$/;
const types=new Set(['text','integer','timestamp','boolean']);
const secret=randomBytes(32);
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code})};
function keys(x,allowed){
  return !!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===allowed.length&&allowed.every(k=>Object.hasOwn(x,k));
}
function invalid(field){fail(422,'INVALID_FIXTURE_SCHEMA','Invalid synthetic fixture schema: '+field+'.')}
const name=x=>typeof x==='string'&&x.length<=120&&x.trim()===x&&x.length>0;
function validateFixture(x){
  if(!keys(x,['source','version','system','datasets'])||typeof x.source!=='string'||!ident.test(x.source)||
      !Number.isSafeInteger(x.version)||x.version<=0)invalid('source identity or version');
  if(!keys(x.system,['id','name','owner'])||typeof x.system.id!=='string'||!ident.test(x.system.id)||!name(x.system.name)||!name(x.system.owner))invalid('system');
  if(!Array.isArray(x.datasets)||!x.datasets.length||x.datasets.length>12)invalid('dataset count');
  const datasets=new Set([x.system.id]),datasetNames=new Set();
  for(const [i,d] of x.datasets.entries()){
    if(!keys(d,['id','name','fields'])||typeof d.id!=='string'||!ident.test(d.id)||datasets.has(d.id)||!name(d.name)||datasetNames.has(d.name.toLowerCase()))invalid('dataset row '+(i+1));
    datasets.add(d.id);datasetNames.add(d.name.toLowerCase());
    if(!Array.isArray(d.fields)||!d.fields.length||d.fields.length>24)invalid('field count for dataset row '+(i+1));
    const fields=new Set();
    for(const [j,f] of d.fields.entries()){
      if(!keys(f,['id','type'])||typeof f.id!=='string'||!column.test(f.id)||fields.has(f.id)||!types.has(f.type))invalid('dataset row '+(i+1)+', field row '+(j+1));
      fields.add(f.id);
    }
  }
  return x;
}
function classify(field){
  if(/(?:^|_)(?:alias|reference)$/.test(field.id))return 'possible identifier';
  if(field.type==='timestamp')return 'timestamp';
  return 'unclassified';
}
function candidateRecords(x){
  return [{sourceId:x.system.id,type:'system',name:x.system.name,owner:x.system.owner,detail:'Synthetic schema origin. No records were scanned.',fields:[]},
    ...x.datasets.map(d=>({sourceId:d.id,type:'dataset',name:d.name,owner:x.system.owner,detail:'Synthetic schema-derived field metadata. No values or samples.',
      fields:d.fields.map(f=>({...f,classification:classify(f)}))}))];
}
const graphOf=state=>state.dataMap??{revision:0,nodes:[],links:[]};
const canonical=x=>JSON.stringify(x);
function prepare(state,actor,request,context,commit=false){
  if(actor!=='analyst')fail(403,'EDITOR_REQUIRED','Only the inventory analyst can review and apply fixture imports.');
  if(!keys(request,commit?['source','version','previewKey']:['source','version'])||
    typeof request.source!=='string'||!ident.test(request.source)||!Number.isSafeInteger(request.version)||request.version<=0)
    fail(422,'INVALID_IMPORT_SELECTION','Choose a bundled source and version. File or sample data is not accepted.');
  const fixture=getFixture(request.source,request.version);
  if(!fixture)fail(404,'FIXTURE_NOT_FOUND','Bundled fixture version not found.');
  validateFixture(fixture);
  const graph=graphOf(state),sourceRows=graph.nodes.filter(n=>n.discovery?.source===fixture.source);
  const incoming=candidateRecords(fixture);
  const ids=new Set(incoming.map(n=>n.sourceId));
  const conflicts=sourceRows.filter(n=>!ids.has(n.discovery.sourceId)).map(n=>({record:n.discovery.sourceId,reason:'Source removed a previously imported record. Manual review is required.'}));
  const candidates=incoming.map(n=>{
    const matches=sourceRows.filter(row=>row.discovery.sourceId===n.sourceId);
    const row=matches[0];
    const fieldHash=createHash('sha256').update(canonical(n.fields)).digest('hex');
    const provenance={source:fixture.source,sourceId:n.sourceId,version:fixture.version,fieldHash,fields:n.fields};
    const reasons=[];
    const nameTaken=graph.nodes.some(x=>x.id!==row?.id&&!x.archivedAt&&x.type===n.type&&x.name.trim().toLowerCase()===n.name.toLowerCase());
    if(matches.length>1||row?.type&&row.type!==n.type)reasons.push('Existing provenance is ambiguous or changed record type.');
    if(row?.archivedAt)reasons.push('An archived record retains this source identity.');
    if(!row&&nameTaken)reasons.push('An active record already uses this name. Rename it manually before importing.');
    if(row?.discovery.version>fixture.version)reasons.push('A newer fixture version is already recorded.');
    if(row?.discovery.version===fixture.version&&row.discovery.fieldHash!==fieldHash)reasons.push('The same source version has incompatible schema metadata.');
    if(reasons.length)conflicts.push({record:n.sourceId,reason:reasons.join(' ')});
    return {sourceId:n.sourceId,type:n.type,name:row?.name??n.name,owner:row?.owner??n.owner,detail:row?.detail??n.detail,
      recordId:row?.id??null,provenance,action:reasons.length?'conflict':!row?'create':row.discovery.version===fixture.version?'unchanged':'refresh-schema'};
  });
  const system=candidates[0];
  const links=candidates.slice(1).map(candidate=>{
    const matching=graph.links.find(l=>l.type==='hosts'&&l.fromId===system.recordId&&l.toId===candidate.recordId&&!l.archivedAt);
    const archived=graph.links.some(l=>l.type==='hosts'&&l.fromId===system.recordId&&l.toId===candidate.recordId&&l.archivedAt);
    if(archived&&!matching)conflicts.push({record:candidate.sourceId,reason:'A deliberately archived host link is not automatically restored.'});
    if(!matching&&system.recordId&&candidate.recordId){
      const onward=new Set([candidate.recordId]);
      for(const id of onward)for(const l of graph.links)if(!l.archivedAt&&l.fromId===id)onward.add(l.toId);
      if(onward.has(system.recordId))conflicts.push({record:candidate.sourceId,reason:'The host link would create a directed cycle.'});
    }
    return {from:system.sourceId,to:candidate.sourceId,action:matching?'unchanged':archived?'conflict':'create'};
  });
  if(graph.nodes.length+candidates.filter(n=>n.action==='create').length>1000||
     graph.links.length+links.filter(l=>l.action==='create').length>3000)conflicts.push({record:null,reason:'Import exceeds the map capacity.'});
  // Scope and account are trusted inputs, not identifiers accepted from the request.
  const plan={source:fixture.source,version:fixture.version,mapRevision:graph.revision,candidates,links,conflicts};
  const previewKey=createHmac('sha256',secret).update(canonical([context,plan])).digest('hex');
  return {...plan,previewKey};
}
function apply(state,actor,request,event,context){
  const before=graphOf(state);
  try{
    const plan=prepare(state,actor,request,context,true);
    if(typeof request.previewKey!=='string'||!/^[0-9a-f]{64}$/.test(request.previewKey)||
      !timingSafeEqual(Buffer.from(plan.previewKey,'hex'),Buffer.from(request.previewKey,'hex')))
      fail(409,'STALE_PREVIEW','Preview this selection again before applying. The map or session scope changed.');
    if(plan.conflicts.length)fail(409,'IMPORT_CONFLICT','Resolve the preview conflicts before applying.');
    const graph=structuredClone(before),ids=new Map();
    const now=new Date().toISOString();
    const result={createdNodes:0,refreshedNodes:0,createdLinks:0};
    for(const node of plan.candidates){
      const id=node.recordId??randomUUID();
      ids.set(node.sourceId,id);
      if(node.action==='create'){
        const {type,name,owner,detail}=node;
        graph.nodes.push({id,type,name,owner,detail,createdAt:now,updatedAt:now,archivedAt:null,discovery:node.provenance});
        result.createdNodes++;
      }else if(node.action==='refresh-schema'){
        const target=graph.nodes.find(n=>n.id===id);
        (target.discoveryHistory??=[]).push(target.discovery);
        target.discovery=node.provenance;target.updatedAt=now;
        result.refreshedNodes++;
      }
    }
    for(const link of plan.links)if(link.action==='create'){
      graph.links.push({id:randomUUID(),type:'hosts',fromId:ids.get(link.from),toId:ids.get(link.to),
        note:'Relationship derived from the bundled synthetic fixture.',createdAt:now,archivedAt:null});
      result.createdLinks++;
    }
    const changed=Object.values(result).some(Boolean);
    if(changed){graph.revision++;state.dataMap=graph;}
    // A no-change repeat is a true no-op, including the audit history.
    if(changed)event(state,actor,'data-map.import.applied',null,null,{source:plan.source,version:plan.version,
      mapRevision:graph.revision,recordIds:[...ids.values()],...result});
    return {...result,mapRevision:graph.revision,changed};
  }catch(error){
    if(error.status){
      event(state,actor,'data-map.import.refused',null,null,{code:error.code,mapRevision:before.revision});
      error.persistRefusal=true;
    }
    throw error;
  }
}
module.exports={validateFixture,fixtureOptions,preview:prepare,apply};
