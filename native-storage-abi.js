'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const format='mvw-trust-native-rust-release';
const abi=2;
const built='native-storage/target/release-artifact/trust_storage.node';
const packaged='native-storage/runtime/trust_storage.node';
const maxBytes=16*1024*1024;
// Explicit native formats; each target has its own CI qualification.
const supported=new Set(['linux:x64','linux:arm64','darwin:x64','darwin:arm64','win32:x64']);
const target=Object.freeze({platform:process.platform,architecture:process.arch,nodeApi:6});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function requireTarget(){
  const nodeApi=Number(process.versions.napi);
  if(!supported.has(process.platform+':'+process.arch)||!Number.isSafeInteger(nodeApi)||nodeApi<target.nodeApi)
    throw Error('Unsupported native Rust release target.');
}
function verifyBinary(bytes){
  requireTarget();
  let valid=false;
  if(Buffer.isBuffer(bytes)&&bytes.length>=64&&bytes.length<=maxBytes){
    if(target.platform==='linux'){
      valid=bytes.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))&&
        bytes.readUInt16LE(16)===3&&bytes.readUInt16LE(18)===(target.architecture==='x64'?62:183);
    }else if(target.platform==='darwin'){
      valid=bytes.readUInt32LE(0)===0xfeedfacf&&
        bytes.readUInt32LE(4)===(target.architecture==='x64'?0x01000007:0x0100000c)&&
        [6,8].includes(bytes.readUInt32LE(12));
    }else if(target.platform==='win32'){
      const pe=bytes.readUInt32LE(60);
      valid=bytes.subarray(0,2).equals(Buffer.from('MZ'))&&pe>=64&&pe<=bytes.length-26&&
        bytes.readUInt32LE(pe)===0x4550&&bytes.readUInt16LE(pe+4)===0x8664&&
        (bytes.readUInt16LE(pe+22)&0x2000)!==0&&bytes.readUInt16LE(pe+24)===0x20b;
    }
  }
  if(!valid)throw Error('Invalid native Rust SQLite binary format.');
}
function descriptor(root){
  const location=path.join(root,'RELEASE-MANIFEST.json');
  let info;
  try{info=fs.lstatSync(location);}catch(error){
    if(error.code!=='ENOENT')throw error;
    if(fs.existsSync(path.join(root,packaged)))throw Error('Native Rust SQLite artifact requires a release manifest.');
    return null;
  }
  if(!info.isFile()||info.nlink!==1||info.size>1024*1024)throw Error('Invalid release manifest.');
  const manifest=JSON.parse(fs.readFileSync(location,'utf8'));
  if(![format,'mvw-trust-native-http-release'].includes(manifest.format)){
    if(fs.existsSync(path.join(root,packaged)))throw Error('Unexpected packaged native Rust SQLite artifact.');
    return null;
  }
  requireTarget();
  if(manifest.version!==1||manifest.nativeAbi!==abi||
    manifest.target?.platform!==target.platform||manifest.target?.architecture!==target.architecture||
    manifest.target?.nodeApi!==target.nodeApi||!Array.isArray(manifest.files))
    throw Error('Invalid native Rust release descriptor.');
  const rows=manifest.files.filter(row=>row.path===packaged);
  if(rows.length!==1||!Number.isSafeInteger(rows[0].size)||rows[0].size<64||rows[0].size>maxBytes||
    typeof rows[0].sha256!=='string'||!/^[a-f0-9]{64}$/.test(rows[0].sha256))throw Error('Invalid native Rust artifact descriptor.');
  return rows[0];
}
function verifyArtifact(root,row){
  for(const folder of ['native-storage','native-storage/runtime']){
    if(!fs.lstatSync(path.join(root,folder)).isDirectory())throw Error('Unsafe native Rust artifact directory.');
  }
  const location=path.join(root,packaged),info=fs.lstatSync(location);
  if(!info.isFile()||info.nlink!==1||info.size!==row.size)throw Error('Native Rust artifact size mismatch.');
  const bytes=fs.readFileSync(location);
  if(bytes.length!==row.size||sha256(bytes)!==row.sha256)throw Error('Native Rust artifact digest mismatch.');
  verifyBinary(bytes);
  return location;
}
module.exports=Object.freeze({format,abi,built,packaged,maxBytes,target,requireTarget,verifyBinary,descriptor,verifyArtifact});
