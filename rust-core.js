'use strict';
// Local, synchronous ABI. No callbacks/imports, no network, and no native addon.
const fs=require('node:fs');
const path=require('node:path');
const mode=process.env.TRUST_RUST_CORE??'auto';
if(!['auto','off','required'].includes(mode))throw Error('TRUST_RUST_CORE must be auto, off or required.');
const artifact=path.join(__dirname,'rust-core','target','wasm32-unknown-unknown','release','trust_core.wasm');
let core;
if(mode!=='off'){
  let bytes;
  try{bytes=fs.readFileSync(artifact);}
  catch(error){if(error.code!=='ENOENT'||mode==='required')throw Error('Rust core artifact unavailable. Run npm run build:rust.',{cause:error});}
  if(bytes){
    const module=new WebAssembly.Module(bytes);
    if(WebAssembly.Module.imports(module).length)throw Error('The Rust core must not import host capabilities.');
    core=new WebAssembly.Instance(module,{}).exports;
    if(!(core.memory instanceof WebAssembly.Memory)||typeof core.trust_abi!=='function'||core.trust_abi()!==2||
      ['trust_reserve','trust_raster','trust_trace','trust_acyclic','trust_due_day','trust_zip','trust_batch_header','trust_batch_layout'].some(key=>typeof core[key]!=='function'))
      throw Error('Incompatible Rust core ABI. Rebuild the Rust core.');
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
module.exports=Object.freeze({enabled:!!core,mode,raster,trace,acyclic,addDays,zip,batchHeader,batchLayout});
