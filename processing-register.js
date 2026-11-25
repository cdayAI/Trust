'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const roles={serviceOwner:'Service owner',recordsSteward:'Records steward',privacyLead:'Privacy lead',securityLead:'Security lead',operationsLead:'Operations lead'};
const subjects={demoCustomers:'Fictional customers',demoStaff:'Fictional staff',demoVendors:'Fictional vendor contacts',demoVisitors:'Fictional visitors'};
const categories={demoContact:'Contact attributes',demoAccount:'Account attributes',demoTransaction:'Transaction attributes',demoDevice:'Device attributes',demoIdentity:'Identity attributes',demoEmployment:'Employment attributes',demoOperational:'Operational attributes'};
const recipientTypes={internal:'Internal team',processor:'Fictional processor',independent:'Fictional independent recipient'};
const destinations={sameRegion:'Same fictional region',otherRegion:'Other fictional region'};
const digest=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
const records=s=>s.processingRegister??[];
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code})};
const invalid=message=>fail(422,'INVALID_PROCESSING_ENTRY',message);
const own=(o,k)=>typeof k==='string'&&Object.hasOwn(o,k);
function fields(payload,keys,label='Submission'){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==keys.length||!keys.every(k=>Object.hasOwn(payload,k)))
    invalid(label+' must provide exactly the supported fields.');
}
function text(value,max,label){
  if(typeof value!=='string'||!value.trim()||value.trim().length>max||value.includes('\0'))invalid(label+' must contain 1 to '+max+' characters.');
  return value.trim();
}
function select(value,values,label){
  if(!own(values,value))invalid('Choose a valid '+label+'.');
  return value;
}
function list(values,min,max,label){
  if(!Array.isArray(values)||values.length<min||values.length>max||new Set(values).size!==values.length)
    invalid(label+' requires '+min+' to '+max+' unique selections.');
  return values;
}
function options(s){
  const graph=s.dataMap??{nodes:[],links:[]};
  const nodes=graph.nodes.filter(x=>!x.archivedAt).map(({id,type,name,owner,updatedAt})=>({id,type,name,owner,updatedAt}));
  const nodeIds=new Set(nodes.map(x=>x.id));
  const links=graph.links.filter(x=>!x.archivedAt&&nodeIds.has(x.fromId)&&nodeIds.has(x.toId))
    .map(({id,type,fromId,toId,note})=>({id,type,fromId,toId,note}));
  const terms=(s.dictionary?.terms??[]).flatMap(term=>{
    const edition=term.versions.find(v=>v.number===term.activeVersion&&v.status==='approved');
    return !term.retiredAt&&edition?[{id:term.id,slug:term.slug,type:term.type,version:edition.number,title:edition.title,definition:edition.definition}]:[];
  });
  const scheduleRows=s.retentionBook?.schedules??[];
  const currentSchedules=new Map();
  for(const r of scheduleRows)if(r.status==='active'&&(!currentSchedules.has(r.category)||currentSchedules.get(r.category).version<r.version))
    currentSchedules.set(r.category,r);
  const schedules=[...currentSchedules.values()].map(({id,category,version,title,trigger,days,disposition})=>({id,category,version,title,trigger,days,disposition}));
  return {nodes,links,terms,schedules};
}
function compile(s,input){
  fields(input,['title','purpose','ownerRole','stewardRole','activityId','systems','datasets','terms','retentionSchedules','subjects','dataCategories','recipients'],'Processing fields');
  const available=options(s),nodes=new Map(available.nodes.map(n=>[n.id,n]));
  function node(id,type){
    const value=nodes.get(id);
    if(!value||value.type!==type)invalid('Choose an active '+type+' from this workspace.');
    return value;
  }
  const activity=node(input.activityId,'activity');
  const systems=list(input.systems,1,8,'Systems').map(id=>node(id,'system'));
  const datasets=list(input.datasets,1,12,'Datasets').map(id=>node(id,'dataset'));
  const systemIds=new Set(systems.map(n=>n.id)),datasetIds=new Set(datasets.map(n=>n.id));
  const hosting=available.links.filter(x=>x.type==='hosts'&&systemIds.has(x.fromId)&&datasetIds.has(x.toId));
  const dataFlows=available.links.filter(x=>x.type==='reads'&&datasetIds.has(x.fromId)&&x.toId===activity.id||
    x.type==='writes'&&x.fromId===activity.id&&datasetIds.has(x.toId));
  if(systems.some(x=>!hosting.some(edge=>edge.fromId===x.id))||
    datasets.some(x=>!hosting.some(edge=>edge.toId===x.id)||!dataFlows.some(edge=>edge.fromId===x.id||edge.toId===x.id)))
    fail(422,'PROCESSING_LINEAGE_REQUIRED','Each dataset must be hosted by a selected system and read or written by the activity. Each system must host a selected dataset.');
  const transferFlows=available.links.filter(x=>x.type==='transfers'&&(systemIds.has(x.fromId)||datasetIds.has(x.fromId)));
  const terms=list(input.terms,1,12,'Dictionary references').map(id=>{
    const row=available.terms.find(x=>x.id===id);
    if(!row)invalid('Choose a currently approved dictionary term from this workspace.');
    return row;
  });
  if(!terms.some(x=>x.type==='purpose'))invalid('Include at least one approved processing purpose from the dictionary.');
  const retentionSchedules=list(input.retentionSchedules,1,3,'Retention schedules').map(id=>{
    const row=available.schedules.find(x=>x.id===id);
    if(!row)invalid('Choose a currently active retention schedule from this workspace.');
    return row;
  });
  const recipientRows=list(input.recipients,0,12,'Recipient entries').map(item=>{
    fields(item,['type','label','destination','safeguards'],'Recipient');
    const destination=select(item.destination,destinations,'fictional destination');
    const type=select(item.type,recipientTypes,'recipient type'),label=text(item.label,120,'Fictional recipient label');
    if(typeof item.safeguards!=='string'||item.safeguards.trim().length>500)invalid('A safeguard note must not exceed 500 characters.');
    const safeguards=item.safeguards.trim();
    if(destination==='otherRegion'&&!safeguards)invalid('A transfer to another fictional region requires a safeguard note.');
    return {type,label,destination,safeguards};
  });
  const subjectCodes=list(input.subjects,1,4,'Subject categories').map(x=>select(x,subjects,'subject category'));
  const categoryCodes=list(input.dataCategories,1,7,'Data categories').map(x=>select(x,categories,'data category'));
  if(new Set(recipientRows.map(x=>JSON.stringify([x.type,x.label.toLowerCase(),x.destination]))).size!==recipientRows.length)
    invalid('Duplicate recipient entries are not allowed.');
  if(transferFlows.length&&!recipientRows.length)
    invalid('The map includes outgoing transfers. Document at least one fictional recipient.');
  const title=text(input.title,160,'Entry title'),purpose=text(input.purpose,1500,'Fictional purpose');
  const ownerRole=select(input.ownerRole,roles,'accountable role'),stewardRole=select(input.stewardRole,roles,'steward role');
  const details={title,purpose,ownerRole,stewardRole,activityId:activity.id,
    systems:[...input.systems],datasets:[...input.datasets],terms:[...input.terms],retentionSchedules:[...input.retentionSchedules],
    subjects:subjectCodes,dataCategories:categoryCodes,recipients:recipientRows};
  const scopeIds=new Set(transferFlows.map(x=>x.toId));
  return {details,snapshot:{title,purpose,accountableRole:roles[ownerRole],stewardRole:roles[stewardRole],
    subjects:subjectCodes.map(x=>subjects[x]),dataCategories:categoryCodes.map(x=>categories[x]),
    recipients:recipientRows.map(({type,label,destination,safeguards})=>({type:recipientTypes[type],label,destination:destinations[destination],safeguards})),
    activity,systems,datasets,lineage:[...hosting,...dataFlows,...transferFlows],transferTargets:available.nodes.filter(n=>scopeIds.has(n.id)),
    dictionaryTerms:terms,retentionSchedules}};
}
function view(s){
  return {entries:records(s),options:options(s),vocabulary:{roles,subjects,categories,recipientTypes,destinations}};
}
function approved(s,id,number){
  const source=id?records(s).filter(x=>x.id===id):records(s);
  if(id&&!source.length)fail(404,'PROCESSING_NOT_FOUND','Processing entry not found in this workspace.');
  const entries=source.flatMap(row=>{
    const release=number?row.versions.find(x=>x.version===number&&x.status==='published'):row.versions.findLast(x=>x.status==='published');
    if(!release)return [];
    return [{entryId:row.id,version:release.version,approvedAt:release.decision.at,reviewedBy:release.decision.account,
      reviewNote:release.decision.note,contentSha256:release.contentSha256,processing:release.snapshot}];
  });
  if(id&&!entries.length)fail(404,'PROCESSING_VERSION_NOT_PUBLISHED','That approved version is not available.');
  return {schemaVersion:1,scope:'synthetic-processing-only',entries};
}
function change(state,parts,role,body,event,_unused,account){
  const [,group,id,raw]=parts,action=parts.length===2?'create':raw;
  if(group!=='entries'||!(parts.length===2||parts.length===4&&['edit','submit','return','publish','revise'].includes(action)))
    fail(404,'PROCESSING_NOT_FOUND','Processing action not found.');
  const review=['publish','return'].includes(action);
  if(role!==(review?'reviewer':'analyst'))fail(403,'PROCESSING_ROLE_REQUIRED','This action requires the '+(review?'independent reviewer':'intake analyst')+'.');
  const identity=account??role,now=new Date().toISOString();
  const book=state.processingRegister??=[];
  fields(body,action==='create'?['details']:['expectedRevision',...(['edit'].includes(action)?['details']:review?['note']:[])]);
  let row=book.find(x=>x.id===id);
  let edition=row?.versions.at(-1);
  if(action==='create'){
    const {details,snapshot}=compile(state,body.details);
    if(book.some(x=>x.activityId===details.activityId))fail(409,'PROCESSING_ACTIVITY_EXISTS','This mapped activity already has an entry. Open its version history to revise it.');
    if(book.length>=300)fail(409,'PROCESSING_LIMIT','The workspace is limited to 300 processing entries.');
    edition={version:1,status:'draft',details,snapshot,contributors:[identity],createdAt:now};
    row={id:randomUUID(),activityId:details.activityId,revision:1,versions:[edition]};book.push(row);
  }else{
    if(!row)fail(404,'PROCESSING_NOT_FOUND','Processing entry not found in this workspace.');
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)invalid('Provide the current entry revision.');
    if(body.expectedRevision!==row.revision)fail(409,'STALE_REVISION','The entry changed. Reload before retrying.');
    if(action==='revise'){
      if(edition.status!=='published')fail(409,'PROCESSING_STATE','Resolve the open version before revising.');
      if(row.versions.length>=100)fail(409,'PROCESSING_LIMIT','This entry has reached its version limit.');
      edition={version:edition.version+1,status:'draft',details:structuredClone(edition.details),snapshot:structuredClone(edition.snapshot),
        contributors:[identity],createdAt:now};row.versions.push(edition);
    }else if(action==='edit'||action==='submit'){
      if(!['draft','returned'].includes(edition.status))fail(409,'PROCESSING_STATE','Only drafts and returned versions can change.');
      const result=compile(state,action==='edit'?body.details:edition.details);
      if(result.details.activityId!==row.activityId)invalid('An entry keeps the same mapped activity throughout its version history.');
      Object.assign(edition,result);
      if(!edition.contributors.includes(identity))edition.contributors.push(identity);
      if(action==='submit'){
        edition.status='in_review';edition.submittedBy=identity;edition.submittedAt=now;
        delete edition.decision;
      }
    }else{
      if(edition.status!=='in_review')fail(409,'PROCESSING_STATE','Submit the version before an independent review.');
      if(edition.contributors.includes(identity))fail(403,'PROCESSING_INDEPENDENCE_REQUIRED','An account that contributed to this version cannot decide it.');
      const note=text(body.note,500,'Reviewer note');
      if(action==='publish'){
        let next;
        try{next=compile(state,edition.details).snapshot}
        catch(error){if(error.status===422)fail(409,'PROCESSING_REFERENCES_CHANGED','A linked map, dictionary, or retention reference changed. Return the version for correction.');throw error}
        if(!isDeepStrictEqual(next,edition.snapshot))fail(409,'PROCESSING_REFERENCES_CHANGED','A linked map, dictionary, or retention reference changed. Return the version for correction.');
        edition.status='published';edition.contentSha256=digest(edition.snapshot);
      }else edition.status='returned';
      edition.decision={account:identity,at:now,note};
    }
    row.revision++;
  }
  event(state,role,'processing-register.'+action,null,row.id,{revision:row.revision,version:edition.version,status:edition.status,
    ...(review?{decision:edition.decision}:{}),...(action==='publish'?{contentSha256:edition.contentSha256}:{})});
}
module.exports={view,approved,change};
