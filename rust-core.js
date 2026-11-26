'use strict';
// Local, synchronous ABI. No callbacks/imports, no network, and no native addon.
const fs=require('node:fs');
const path=require('node:path');
const contract=require('./rust-core-abi');
const requested=process.env.TRUST_RUST_CORE??'auto';
if(!['auto','off','required'].includes(requested))throw Error('TRUST_RUST_CORE must be auto, off or required.');
function releaseDescriptor(){
  const location=path.join(__dirname,'RELEASE-MANIFEST.json');
  let info;
  try{info=fs.lstatSync(location);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!info.isFile()||info.nlink!==1||info.size>1024*1024)throw Error('Invalid release manifest.');
  const manifest=JSON.parse(fs.readFileSync(location,'utf8'));
  if(manifest.format!==contract.format)return null;
  if(manifest.version!==1||manifest.wasmAbi!==contract.abi||!Array.isArray(manifest.files))throw Error('Invalid Rust release manifest.');
  const rows=manifest.files.filter(entry=>entry.path===contract.packaged);
  if(rows.length!==1||!Number.isSafeInteger(rows[0].size)||rows[0].size<1||rows[0].size>contract.maxBytes||
    typeof rows[0].sha256!=='string'||!/^[a-f0-9]{64}$/.test(rows[0].sha256))throw Error('Invalid Rust release artifact descriptor.');
  return rows[0];
}
const descriptor=releaseDescriptor();
if(descriptor&&requested==='off')throw Error('A compiled Rust release cannot disable its Rust core. Use the separate source release for rollback.');
const mode=descriptor?'required':requested;
const artifact=path.join(__dirname,...(descriptor?contract.packaged:contract.built).split('/'));
let core;
if(mode!=='off'){
  let bytes;
  try{
    if(descriptor){
      for(const directory of ['rust-core','rust-core/runtime']){
        const info=fs.lstatSync(path.join(__dirname,...directory.split('/')));
        if(!info.isDirectory())throw Error('Unsafe Rust release artifact directory.');
      }
      const info=fs.lstatSync(artifact);
      if(!info.isFile()||info.nlink!==1||info.size!==descriptor.size)throw Error('Rust release artifact size mismatch.');
    }
    bytes=fs.readFileSync(artifact);
  }catch(error){
    if(error.code!=='ENOENT'||mode==='required')throw Error('Rust core artifact unavailable or invalid.',{cause:error});
  }
  if(bytes){
    if(descriptor&&(bytes.length!==descriptor.size||contract.sha256(bytes)!==descriptor.sha256))throw Error('Rust release artifact digest mismatch.');
    core=contract.instantiate(bytes);
  }
}
const maxBuffer=8*1024*1024;
function withBuffer(input,outputBytes,call){
  if(!core)throw Error('Rust core is not active.');
  const size=input.byteLength+outputBytes;
  if(!Number.isSafeInteger(size)||size<0||size>maxBuffer)throw Error('Rust core buffer limit exceeded.');
  const ptr=core.trust_reserve(size)>>>0;
  if(!ptr||ptr+size>core.memory.buffer.byteLength)throw Error('Rust core returned an invalid buffer.');
  try{
    new Uint8Array(core.memory.buffer,ptr,input.byteLength).set(input);
    return call(ptr);
  }finally{
    // Recreate the view because a Rust allocation can grow linear memory.
    new Uint8Array(core.memory.buffer,ptr,size).fill(0);
  }
}
function raster(kind,bytes){
  if(!Number.isInteger(kind)||kind<1||kind>6||!(bytes instanceof Uint8Array))throw Error('Invalid raster request.');
  if(bytes.length>1024*1024)return 0;
  return withBuffer(bytes,0,()=>{
    const result=core.trust_raster(kind);
    if(![0,1,2].includes(result))throw Error('Invalid Rust raster result.');
    return result;
  });
}
function encodeEdges(nodes,edges){
  if(nodes.length>100000||edges.length>500000)throw Error('Rust graph limit exceeded.');
  const byId=new Map(nodes.map((id,i)=>[id,i]));
  if(byId.size!==nodes.length)throw Error('Duplicate graph nodes.');
  const input=Buffer.alloc(edges.length*8);
  for(const [index,[from,to]] of edges.entries()){
    if(!byId.has(from)||!byId.has(to))throw Error('Unresolved graph endpoint.');
    input.writeUInt32LE(byId.get(from),index*8);
    input.writeUInt32LE(byId.get(to),index*8+4);
  }
  return {byId,input};
}
function trace(start,adjacency){
  const nodes=[...adjacency.keys()];
  const edges=[];
  for(const [from,targets] of adjacency)for(const to of targets)edges.push([from,to]);
  const {input,byId}=encodeEdges(nodes,edges);
  if(!byId.has(start))throw Error('Missing graph start.');
  return withBuffer(input,nodes.length*4,ptr=>{
    const count=core.trust_trace(nodes.length,edges.length,byId.get(start));
    if(count<0||count>=nodes.length)throw Error('Invalid Rust graph traversal result.');
    const result=new DataView(core.memory.buffer,ptr+input.length,count*4);
    return Array.from({length:count},(_,i)=>{
      const index=result.getUint32(i*4,true);
      if(index>=nodes.length)throw Error('Invalid Rust graph index.');
      return nodes[index];
    });
  });
}
function acyclic(nodes,edges){
  const {input}=encodeEdges(nodes,edges);
  return withBuffer(input,0,()=>{
    const result=core.trust_acyclic(nodes.length);
    if(result!==0&&result!==1)throw Error('Invalid Rust graph validation result.');
    return result===1;
  });
}
function addDays(from,days,basis,closedDates=[]){
  const day=value=>new Date(value.slice(0,10)+'T00:00:00Z').getTime()/86400000;
  const start=day(from);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(days)||days<0||days>100000||
    !['calendar','business'].includes(basis)||!Array.isArray(closedDates)||closedDates.length>64)
    throw Error('Invalid Rust calendar input.');
  const input=Buffer.alloc(closedDates.length*4);
  for(const [i,date] of closedDates.entries()){
    const value=day(date);
    if(!Number.isSafeInteger(value))throw Error('Invalid Rust calendar exclusion.');
    input.writeInt32LE(value,i*4);
  }
  const end=withBuffer(input,0,()=>core.trust_due_day(start,days,basis==='business'?1:0));
  if(end===-2147483648)throw Error('Rust calendar result outside bounds.');
  return new Date(end*86400000).toISOString().slice(0,10);
}
function zip(bytes){
  if(!Buffer.isBuffer(bytes))throw Error('Invalid archive input.');
  if(bytes.length>4*1024*1024)return null;
  const stride=12*4;
  return withBuffer(bytes,256*stride,ptr=>{
    const count=core.trust_zip(bytes.length);
    if(count===-1)return null;
    if(count<1||count>256)throw Error('Invalid Rust ZIP count.');
    const output=new DataView(core.memory.buffer,ptr+bytes.length,count*stride);
    return Array.from({length:count},(_,i)=>{
      const [nameAt,nameEnd,directory,loc,method,flags,localExtras,centralExtras,start,end,size,crc]=
        Array.from({length:12},(_,word)=>output.getUint32(i*stride+word*4,true));
      if(nameAt>=nameEnd||nameEnd>bytes.length||start>end||end>bytes.length||directory>1||
        ![0,8].includes(method)||loc>=start||size>2*1024*1024)throw Error('Invalid Rust ZIP row.');
      return {name:bytes.toString('latin1',nameAt,nameEnd),directory:directory===1,loc,method,flags,localExtras,centralExtras,start,end,size,crc};
    });
  });
}
function batchHeader(bytes){
  if(!Buffer.isBuffer(bytes))throw Error('Invalid batch input.');
  return withBuffer(bytes.subarray(0,4),0,()=>core.trust_batch_header(bytes.length));
}
function batchLayout(frameLen,manifest,sizes){
  if(!Number.isSafeInteger(frameLen)||frameLen<0||frameLen>0xffffffff||
    !Number.isSafeInteger(manifest)||manifest<0||manifest>0xffffffff||
    !Array.isArray(sizes)||sizes.length<1||sizes.length>4)throw Error('Invalid batch layout input.');
  const input=Buffer.alloc(sizes.length*4);
  sizes.forEach((size,i)=>input.writeUInt32LE(size,i*4));
  return withBuffer(input,0,ptr=>{
    const count=core.trust_batch_layout(frameLen,manifest);
    if(count===-1||count===-2)return count;
    if(count!==sizes.length)throw Error('Invalid Rust batch count.');
    const output=new DataView(core.memory.buffer,ptr,count*4);
    const offsets=Array.from({length:count},(_,i)=>output.getUint32(i*4,true));
    let expected=4+manifest;
    for(let i=0;i<count;i++){
      if(offsets[i]!==expected||expected+sizes[i]>frameLen)throw Error('Invalid Rust batch offset.');
      expected+=sizes[i];
    }
    if(expected!==frameLen)throw Error('Invalid Rust batch end.');
    return offsets;
  });
}
const workflowRoles=['publisher','initiator','reviewer'];
function roleBit(roles,role){const i=roles.indexOf(role);return i<0?0:1<<i;}
function workflowPermission(transition,actor,instance){
  const ids=new Map();
  const number=value=>{if(!ids.has(value))ids.set(value,ids.size+1);return ids.get(value);};
  const input=Buffer.alloc(instance.contributors.length*4);
  instance.contributors.forEach((id,i)=>input.writeUInt32LE(number(id),i*4));
  const role=roleBit(workflowRoles,actor?.role);
  const allowed=transition.roles.reduce((mask,r)=>mask|roleBit(workflowRoles,r),0);
  const current=actor?number(actor.id):0,legacy=actor?.legacyId?number(actor.legacyId):0,creator=number(instance.createdBy);
  const result=withBuffer(input,0,()=>core.trust_workflow_permission(role,allowed,transition.independent?1:0,current,legacy,creator));
  if(![0,1,2].includes(result))throw Error('Invalid Rust workflow decision.');
  return result;
}
const tiers=['low','moderate','high','critical'];
function riskScore(profile,likelihood,impact,extras=0){
  if(![profile,likelihood,impact,extras].every(Number.isInteger))throw Error('Invalid Rust risk score input.');
  const result=core.trust_risk_score(profile,likelihood,impact,extras);
  if(result<0||!tiers[result>>>8])throw Error('Invalid Rust risk score.');
  return {value:result&255,tier:tiers[result>>>8]};
}
function linkReason(link,test){
  const flags=(link.archivedAt?1:0)|(link.reviewedBy?2:0)|(test?4:0)|(test?.outcome==='fail'?8:0);
  const code=core.trust_link_status(flags,test?.reviewStatus==='accepted'?1:test?.reviewStatus==='rejected'?2:0);
  const reasons=['unlinked','link-awaiting-review','untested','latest-test-failed','verified-pass','review-rejected','awaiting-independent-review'];
  if(!reasons[code])throw Error('Invalid Rust link status.');
  return reasons[code];
}
function reductions(links){
  const verified=links.filter(link=>link.applies);
  const input=Buffer.alloc(verified.length*2);
  for(const [i,link] of verified.entries()){
    const {likelihood,impact}=link.reduction;
    if(!Number.isInteger(likelihood)||likelihood<0||likelihood>2||!Number.isInteger(impact)||impact<0||impact>2)
      throw Error('Invalid Rust risk reduction.');
    input[i*2]=likelihood;input[i*2+1]=impact;
  }
  const result=withBuffer(input,0,()=>core.trust_reductions());
  if(result<0)throw Error('Invalid Rust reduction result.');
  return {likelihood:result&255,impact:result>>>8};
}
function accountLive(account,at){
  return !!account&&core.trust_account_live(account.disabled?1:0,account.validUntil===null?0:1,at,account.validUntil??0)===1;
}
function sessionToken(name,header){
  const prefix=Buffer.from(name,'utf8'),bytes=Buffer.from(header,'utf8');
  return withBuffer(Buffer.concat([prefix,bytes]),43,ptr=>{
    const result=core.trust_cookie(prefix.length,bytes.length);
    if(result===0)return null;
    if(result!==1)throw Error('Invalid Rust cookie result.');
    return Buffer.from(new Uint8Array(core.memory.buffer,ptr+prefix.length+bytes.length,43)).toString('ascii');
  });
}
function aggregateReport(source,filters,vocabulary){
  const groups=['workflow','stage','outcome','day','month'];
  const {workflow,stage,outcome,group,from,to}=filters;
  const dimension=(list,value)=>{
    if(value==='all'||value===undefined)return 0;
    const n=list.indexOf(value)+1;
    if(!n)throw Error('Unknown Rust reporting dimension.');
    return n;
  };
  const day=value=>value?Number(value.replaceAll('-','')):0;
  const w=dimension(vocabulary.workflow,workflow),s=dimension(vocabulary.stage,stage),o=dimension(vocabulary.outcome,outcome);
  const g=groups.indexOf(group),first=day(from),last=day(to);
  if(g<0||vocabulary.workflow.length>31)throw Error('Invalid Rust reporting dimensions.');
  const maxRows=16384,buffer=Buffer.alloc(maxRows*16);
  let count=0,total=0,undated=0,areas=0;
  const buckets=new Map();
  function flush(){
    if(!count)return;
    const length=count*16;
    withBuffer(buffer.subarray(0,length),12+count*8,ptr=>{
      const n=core.trust_report(length,w,s,o,g,first,last);
      if(n<0||n>count)throw Error('Invalid Rust report result.');
      const view=new DataView(core.memory.buffer,ptr+length,12+n*8);
      total+=view.getUint32(0,true);undated+=view.getUint32(4,true);areas|=view.getUint32(8,true);
      for(let i=0;i<n;i++){
        const key=view.getUint32(12+i*8,true),amount=view.getUint32(16+i*8,true);
        buckets.set(key,(buckets.get(key)??0)+amount);
      }
    });
    count=0;
  }
  for(const row of source){
    const w=dimension(vocabulary.workflow,row.workflow),s=dimension(vocabulary.stage,row.stage),o=dimension(vocabulary.outcome,row.outcome);
    if(!w)throw Error('Unknown Rust report workflow.');
    for(const [i,value] of [w,s,o,day(row.day)].entries())buffer.writeUInt32LE(value,count*16+i*4);
    if(++count===maxRows)flush();
  }
  flush();
  const names=new Map();
  for(const [key,amount] of buckets){
    let name;
    if(g<3)name=vocabulary[group][key-1];
    else if(!key)name='undated';
    else{
      const value=String(key).padStart(g===3?8:6,'0');
      name=value.slice(0,4)+'-'+value.slice(4,6)+(g===3?'-'+value.slice(6,8):'');
    }
    if(name===undefined)throw Error('Invalid Rust report bucket.');
    names.set(name,amount);
  }
  let workflowCount=0;
  for(let i=0;i<vocabulary.workflow.length;i++)if(areas&(1<<i))workflowCount++;
  return {buckets:names,total,undated,workflowCount};
}
const workspaceRoles=['analyst','reviewer','case-operator','publisher','identity-admin','ethics-investigator','ethics-reviewer'];
const methodCode=method=>method==='GET'?1:method==='POST'?2:0;
// Expand only the existing bounded route grammar. Unsupported syntax fails
// startup instead of being treated as a permissive wildcard.
function expandRoute(pattern){
  const tokens=[
    ['[a-zA-Z0-9][a-zA-Z0-9-]{0,127}','@key'],
    ['[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}','@uuid'],
    ['[1-9][0-9]*','@version'],['[a-f0-9]{64}','@task']
  ];
  for(const [source,token] of tokens)pattern=pattern.replaceAll(source,token);
  let pos=0;
  function expression(depth){
    if(depth>16)throw Error('Rust route nesting limit exceeded.');
    let alternatives=[],sequence=[''];
    while(pos<pattern.length&&pattern[pos]!==')'){
      if(pattern[pos]==='|'){alternatives.push(...sequence);sequence=[''];pos++;continue;}
      let next;
      if(pattern.startsWith('(?:',pos)){
        pos+=3;next=expression(depth+1);
        if(pattern[pos++]!==')')throw Error('Unclosed Rust route group.');
        if(pattern[pos]==='?'){next.push('');pos++;}
      }else{
        const char=pattern[pos++];
        if(!/[a-z0-9/@-]/.test(char))throw Error('Unsupported Rust route grammar: '+char);
        next=[char];
      }
      if(sequence.length*next.length>2048)throw Error('Rust route expansion limit exceeded.');
      sequence=sequence.flatMap(prefix=>next.map(suffix=>prefix+suffix));
    }
    alternatives.push(...sequence);
    if(alternatives.length>2048)throw Error('Rust route alternatives limit exceeded.');
    return alternatives;
  }
  const result=expression(0);
  if(pos!==pattern.length)throw Error('Unexpected Rust route terminator.');
  return result;
}
function installRoutes(routes){
  const lines=[];
  for(const {method,value,roles} of routes){
    const code=methodCode(method),mask=roles.reduce((m,r)=>m|roleBit(workspaceRoles,r),0);
    if(!code||!mask||roles.some(role=>!workspaceRoles.includes(role)))throw Error('Invalid Rust route declaration.');
    for(const path of expandRoute(value))lines.push(code+'\t'+mask+'\t/api/'+path);
  }
  if(withBuffer(Buffer.from(lines.join('\n')),0,()=>core.trust_routes_init())!==1)
    throw Error('Rust route initialization failed.');
}
function authorize(method,pathname,role,limited){
  const result=withBuffer(Buffer.from(pathname,'utf8'),0,()=>core.trust_authorize(methodCode(method),roleBit(workspaceRoles,role),limited?1:0));
  if(![0,1,2,3].includes(result))throw Error('Invalid Rust authorization result.');
  return result;
}
function word(value){const b=Buffer.alloc(4);b.writeUInt32LE(value);return b;}
function encodedUnits(value){
  if(typeof value!=='string')return word(0xffffffff);
  return Buffer.concat([word(value.length),Buffer.from(value,'utf16le')]);
}
function revision(expected,actual,min){
  const result=core.trust_revision(typeof expected==='number'?expected:NaN,typeof actual==='number'?actual:NaN,min);
  if(result===3)throw Error('Invalid stored workflow revision.');
  if(![0,1,2].includes(result))throw Error('Invalid Rust revision result.');
  return result;
}
function workflowPlan(t,actor,instance,body){
  const ids=new Map(),names=[];
  const number=value=>{if(!ids.has(value)){names.push(value);ids.set(value,names.length);}return ids.get(value);};
  const contributors=instance.contributors.map(number);
  const current=number(actor.id),legacy=actor.legacyId?number(actor.legacyId):0,creator=number(instance.createdBy);
  const role=roleBit(workflowRoles,actor.role);
  const allowed=t?t.roles.reduce((mask,r)=>mask|roleBit(workflowRoles,r),0):0;
  const available=!!t&&t.from===instance.state;
  const required=t?.requiredFields??[];
  const validBody=!!body&&typeof body==='object'&&!Array.isArray(body);
  let entries=validBody?Object.entries(body):[];
  // Oversized direct-engine callers can contain large surrounding whitespace;
  // trim only for the bridge's maximum allocation, preserving JS semantics.
  if(entries.length<=20)entries=entries.map(([key,value])=>[key,typeof value==='string'&&value.length>65536?value.trim():value]);
  const validShape=validBody&&entries.length<=20;
  const chunks=[word(contributors.length),...contributors.map(word),word(validShape?entries.length:0xffffffff),word(required.length)];
  if(validShape){
    for(const [key,value] of entries){
      chunks.push(encodedUnits(key.length<=64?key:null),encodedUnits(typeof value==='string'&&value.length<=65536?value:null));
    }
    for(const key of required)chunks.push(encodedUnits(key));
  }
  const input=Buffer.concat(chunks);
  const count=validShape?entries.length:0;
  return withBuffer(input,8+count*8+(contributors.length+1)*4,ptr=>{
    const status=core.trust_transition(input.length,available?1:0,role,allowed,t?.independent?1:0,current,legacy,creator);
    if(![0,1,2,3,4,5].includes(status))throw Error('Invalid Rust workflow plan.');
    const view=new DataView(core.memory.buffer,ptr+input.length);
    if(status===5){
      const mask=view.getUint32(0,true);
      return {status,missing:required.filter((_,i)=>mask&(1<<i))};
    }
    if(status)return {status};
    const fields=Object.fromEntries(entries.map(([key,value],i)=>{
      const start=view.getUint32(8+i*8,true),end=view.getUint32(12+i*8,true);
      if(typeof value!=='string'||start>=end||end>value.length)throw Error('Invalid Rust workflow field range.');
      return [key,value.slice(start,end)];
    }));
    const n=view.getUint32(4,true);
    if(n>contributors.length+1)throw Error('Invalid Rust contributor count.');
    const next=Array.from({length:n},(_,i)=>{
      const id=view.getUint32(8+count*8+i*4,true);
      if(!id||id>names.length)throw Error('Invalid Rust contributor identifier.');
      return names[id-1];
    });
    return {status,fields,contributors:next};
  });
}
function questionnaireAnswer(question,input,active,provided,submitting){
  const flags=(active?1:0)|(provided?2:0)|(question.required?4:0)|(submitting?8:0);
  const kind=question.kind==='integer'?1:question.kind==='choice'?2:0;
  const options=kind===2?question.options:[];
  const value=typeof input==='string'&&input.length<=2000?input:null;
  const bytes=Buffer.concat([encodedUnits(value),word(options.length),...options.map(encodedUnits)]);
  return withBuffer(bytes,8,ptr=>{
    const status=core.trust_answer(bytes.length,flags,kind);
    if(![0,1,2,3,4,5,6].includes(status))throw Error('Invalid Rust questionnaire result.');
    if(status)return {status};
    const view=new DataView(core.memory.buffer,ptr+bytes.length,8);
    const start=view.getUint32(0,true),end=view.getUint32(4,true);
    if(typeof value!=='string'||start>end||end>value.length)throw Error('Invalid Rust answer range.');
    return {status,value:value.slice(start,end)};
  });
}
function storageScope(scope){
  if(typeof scope!=='string'||scope.length>58)return 0;
  const result=withBuffer(Buffer.from(scope,'utf8'),0,()=>core.trust_storage_scope());
  if(![0,1,2].includes(result))throw Error('Invalid Rust storage scope result.');
  return result;
}
function storageGeneration(value){
  return core.trust_storage_generation(typeof value==='number'?value:NaN)===1;
}
function storagePayload(kind,payload){
  const workbench=kind==='workbench';
  const code=workbench?1:kind==='workflow'?2:0;
  const keys=workbench?['actors','projects','vendors','assessments','handoff','audit']:['definitions','instances','events'];
  const flags=keys.reduce((mask,key,i)=>mask|(Array.isArray(payload[key])?1<<i:0),0);
  const version=workbench?payload.version:payload.schemaVersion;
  return core.trust_storage_payload(code,typeof version==='number'?version:NaN,flags)===1;
}
function encryptedSize(header,archiveSize){
  if(!Buffer.isBuffer(header)||header.length!==26||!Number.isSafeInteger(archiveSize))return -1;
  return withBuffer(header,0,()=>core.trust_backup_header(archiveSize));
}
function incidentReady(row){
  const flags=(row.containment?1:0)|(row.findings?2:0)|(row.branch==='elevated'?4:0)|
    (row.evidence.some(e=>e.kind==='impact')?8:0)|(row.review?.decision==='more-information'?16:0)|
    (row.lastInvestigationRevision>row.review?.revision?32:0);
  return core.trust_incident_ready(flags,row.evidence.length)===1;
}
function retentionReason(holds,schedule,triggeredOn,asOf,dueOn){
  const flags=(holds.length?1:0)|(schedule?2:0)|(triggeredOn?4:0)|(asOf<dueOn?8:0);
  const result=core.trust_retention_reason(flags);
  const reasons=['ACTIVE_HOLD','NO_ACTIVE_SCHEDULE','TRIGGER_NOT_RECORDED','BEFORE_DUE_DATE','ELIGIBLE'];
  if(!reasons[result])throw Error('Invalid Rust retention decision.');
  return reasons[result];
}
function httpEnvelope(fields){
  const buffers=[];
  for(const field of fields){
    const bytes=Buffer.from(field,'utf8');
    if(bytes.length>32*1024)return null;
    buffers.push(word(bytes.length),bytes);
  }
  return Buffer.concat(buffers);
}
const headerValue=value=>typeof value==='string'?value:value?'\u0000':'';
function httpConnection(remote,host,target,corporateHost,encrypted,secure){
  const corporate=corporateHost!==undefined;
  const input=httpEnvelope([headerValue(remote),headerValue(host),headerValue(target),headerValue(corporateHost)]);
  if(!input)return corporate?2:1;
  const result=withBuffer(input,0,()=>core.trust_http_connection((corporate?1:0)|(encrypted?2:0)|(secure?4:0)));
  if(![0,1,2].includes(result))throw Error('Invalid Rust HTTP connection result.');
  return result;
}
function httpPost(host,origin,corporateOrigin,contentType,contentEncoding,binaryType,isolated,binary){
  const input=httpEnvelope([headerValue(host),headerValue(origin),headerValue(corporateOrigin),
    headerValue(contentType),headerValue(contentEncoding),headerValue(binaryType)]);
  if(!input)return 1;
  const flags=(isolated?1:0)|(corporateOrigin!==undefined?2:0)|(binary?4:0);
  const result=withBuffer(input,0,()=>core.trust_http_post(flags));
  if(![0,1,2,3].includes(result))throw Error('Invalid Rust HTTP POST result.');
  return result;
}
module.exports=Object.freeze({enabled:!!core,mode,raster,trace,acyclic,addDays,zip,batchHeader,batchLayout,
  workflowPermission,riskScore,linkReason,reductions,accountLive,sessionToken,aggregateReport,expandRoute,installRoutes,authorize,revision,workflowPlan,questionnaireAnswer,
  storageScope,storageGeneration,storagePayload,encryptedSize,incidentReady,retentionReason,httpConnection,httpPost});
