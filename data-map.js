'use strict';
const {randomUUID}=require('node:crypto');
const dictionary=require('./data-dictionary');

const nodeTypes={
  system:{label:'System',detail:'Hosting context'},
  dataset:{label:'Dataset',detail:'Fictional data categories'},
  activity:{label:'Processing activity',detail:'Processing purpose'}
};
const linkTypes={
  hosts:{label:'Hosts',from:['system'],to:['dataset']},
  reads:{label:'Feeds activity',from:['dataset'],to:['activity']},
  writes:{label:'Writes',from:['activity'],to:['dataset']},
  transfers:{label:'Transfers to',from:['dataset','system'],to:['dataset','system']},
};
const collections=s=>s.dataMap??{revision:0,nodes:[],links:[]};
function issue(status,code,message){throw Object.assign(new Error(message),{status,code})}
function str(value,field,max){
  if(typeof value!=='string'||!value.trim()||value.length>max)issue(422,'FIELD_REQUIRED',field+' must contain 1 to '+max+' characters.');
  return value.trim();
}
function only(body,allowed){
  if(Object.keys(body).some(x=>!allowed.includes(x)))issue(422,'UNKNOWN_FIELDS','Unsupported fields. Types and link endpoints cannot be edited.');
}
function adjacency(nodes,links,reverse=false){
  const edges=new Map(nodes.map(x=>[x.id,new Set()]));
  for(const link of links){
    if(link.archivedAt)continue;
    edges.get(reverse?link.toId:link.fromId)?.add(reverse?link.fromId:link.toId);
  }
  return edges;
}
function trace(start,edges){
  const ids=new Set([start]);
  const work=[start];
  for(let i=0;i<work.length;i++){
    for(const next of edges.get(work[i])??[])if(!ids.has(next)){ids.add(next);work.push(next)}
  }
  ids.delete(start);
  return Array.from(ids);
}
function view(state){
  const graph=collections(state);
  const downstream=adjacency(graph.nodes,graph.links), upstream=adjacency(graph.nodes,graph.links,true);
  const terms=dictionary.mapProjection(state);
  const usage=new Map(graph.nodes.map(n=>[n.id,{incoming:0,outgoing:0}]));
  for(const link of graph.links)if(!link.archivedAt){
    usage.get(link.toId).incoming++;usage.get(link.fromId).outgoing++;
  }
  return {revision:graph.revision,nodeTypes,linkTypes,
    nodes:graph.nodes.map(n=>({...n,...(terms.has(n.id)?{dictionaryTerms:terms.get(n.id)}:{}),usage:usage.get(n.id),upstream:[...upstream.get(n.id)],downstream:[...downstream.get(n.id)]})),
    links:graph.links,
    cyclePolicy:'Active directed links that would create a cycle are refused.',
    legacyRecords:(state.moduleRecords??[]).filter(r=>['inventory','processing'].includes(r.moduleId))};
}
function lineage(state,id){
  const graph=collections(state),node=graph.nodes.find(n=>n.id===id);
  if(!node)issue(404,'NODE_NOT_FOUND','Inventory record not found.');
  const byId=new Map(graph.nodes.map(n=>[n.id,n]));
  return {revision:graph.revision,node,
    upstream:trace(id,adjacency(graph.nodes,graph.links,true)).map(x=>byId.get(x)),
    downstream:trace(id,adjacency(graph.nodes,graph.links)).map(x=>byId.get(x))};
}
function change(state,parts,actor,body,event){
  const graph=state.dataMap??=collections(state);
  const [,collection,id,action]=parts;
  if(!['nodes','links'].includes(collection)||!(parts.length===2||
      (parts.length===4&&id&&(['archive'].includes(action)||(collection==='nodes'&&action==='update'))))) {
    issue(404,'NOT_FOUND','Data mapping action not found.');
  }
  const row=id?graph[collection].find(r=>r.id===id):null;
  function record(kind,target,details){event(state,actor,'data-map.'+kind,null,target,{...details,mapRevision:graph.revision});}
  try{
    if(actor!=='analyst')issue(403,'EDITOR_REQUIRED','Only the inventory analyst can change the map.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)issue(422,'REVISION_REQUIRED','Provide the current map revision.');
    if(body.expectedRevision!==graph.revision)issue(409,'STALE_REVISION','The map changed. Reload before retrying.');
    const now=new Date().toISOString();
    let kind, result, details;
    if(parts.length===2&&collection==='nodes'){
      only(body,['type','name','owner','detail','expectedRevision']);
      if(typeof body.type!=='string'||!Object.hasOwn(nodeTypes,body.type))issue(422,'INVALID_NODE_TYPE','Select a valid record type.');
      if(graph.nodes.length>=1000)issue(409,'MAP_LIMIT','The local demo supports up to 1,000 inventory records.');
      result={id:randomUUID(),type:body.type,name:str(body.name,'Name',120),owner:str(body.owner,'Fictional owner',120),
        detail:str(body.detail,nodeTypes[body.type].detail,1000),createdAt:now,updatedAt:now,archivedAt:null};
      graph.nodes.push(result);kind='node.created';details={record:{...result}};
    }else if(parts.length===2){
      only(body,['type','fromId','toId','note','expectedRevision']);
      if(typeof body.type!=='string'||!Object.hasOwn(linkTypes,body.type))issue(422,'INVALID_LINK_TYPE','Select a valid link type.');
      const {type,fromId,toId}=body;
      const from=graph.nodes.find(x=>x.id===fromId),to=graph.nodes.find(x=>x.id===toId), rule=linkTypes[type];
      if(!from||!to||from.archivedAt||to.archivedAt)issue(422,'INVALID_ENDPOINT','Choose two existing, active inventory records.');
      if(from.id===to.id)issue(409,'CYCLE','Self links are not allowed.');
      if(!rule.from.includes(from.type)||!rule.to.includes(to.type))issue(422,'INCOMPATIBLE_TYPES','The selected record types cannot use this link.');
      if(graph.links.some(x=>!x.archivedAt&&x.type===type&&x.fromId===fromId&&x.toId===toId))issue(409,'DUPLICATE_LINK','This active link already exists.');
      if(trace(toId,adjacency(graph.nodes,graph.links)).includes(fromId))issue(409,'CYCLE','This link would create a directed cycle.');
      if(graph.links.length>=3000)issue(409,'MAP_LIMIT','The local demo supports up to 3,000 links.');
      result={id:randomUUID(),type,fromId,toId,note:str(body.note,'Fictional flow purpose',1000),createdAt:now,archivedAt:null};
      graph.links.push(result);kind='link.created';details={link:{...result}};
    }else{
      if(!row)issue(404,'RECORD_NOT_FOUND','Map record not found.');
      if(row.archivedAt)issue(409,'ALREADY_ARCHIVED','This record is already archived.');
      result=row;
      if(action==='update'){
        only(body,['name','owner','detail','expectedRevision']);
        const patch={name:str(body.name,'Name',120),owner:str(body.owner,'Fictional owner',120),
          detail:str(body.detail,nodeTypes[row.type].detail,1000)};
        details={previous:{name:row.name,owner:row.owner,detail:row.detail},record:patch};
        Object.assign(row,patch,{updatedAt:now});kind='node.updated';
      }else{
        only(body,['expectedRevision','note']);
        const note=str(body.note,'Archive rationale',1000);
        if(collection==='nodes'&&graph.links.some(l=>!l.archivedAt&&(l.fromId===id||l.toId===id)))issue(409,'ACTIVE_LINKS','Archive the active links before archiving this record.');
        if(collection==='nodes'&&dictionary.hasNodeReferences(state,id))issue(409,'TERM_REFERENCES','Detach dictionary terms before archiving this record.');
        row.archivedAt=now;
        kind=collection==='nodes'?'node.archived':'link.archived';details={note};
      }
    }
    graph.revision++;
    record(kind,result.id,details);
  }catch(error){
    if(!error.status)throw error;
    record('refused',row?.id??null,{collection,requestedAction:action??'create',code:error.code,
      expectedRevision:Number.isSafeInteger(body.expectedRevision)?body.expectedRevision:null});
    throw Object.assign(error,{persistRefusal:true});
  }
}
module.exports={view,lineage,change};
