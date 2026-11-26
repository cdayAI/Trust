'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const format='mvw-trust-native-rust-release';
const abi=1;
const built='native-storage/target/release-artifact/trust_storage.node';
const packaged='native-storage/runtime/trust_storage.node';
const maxBytes=16*1024*1024;
// Only the currently qualified native target is distributable. Developer
// builds on other platforms remain opt-in until their complete tests pass.
const target=Object.freeze({platform:'linux',architecture:'x64',nodeApi:6});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function requireTarget(){
  const nodeApi=Number(process.versions.napi);
  if(process.platform!==target.platform||process.arch!==target.architecture||!Number.isSafeInteger(nodeApi)||nodeApi<target.nodeApi)
    throw Error('Unsupported native Rust release target.');
}
function verifyBinary(bytes){
  // ELF64 little-endian, x86-64, shared object. This is a format check,
  // not an assertion of provenance, safety, or a cryptographic signature.
  if(!Buffer.isBuffer(bytes)||bytes.length<64||bytes.length>maxBytes||
    !bytes.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))||
    bytes.readUInt16LE(16)!==3||bytes.readUInt16LE(18)!==62)
    throw Error('Invalid native Rust SQLite binary format.');
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
  if(manifest.format!==format){
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
