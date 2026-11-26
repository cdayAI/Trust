'use strict';
import fs = require('node:fs');
import path = require('node:path');
import {createHash} from 'node:crypto';
import type {ArtifactRow} from './contracts';

function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function missing(error:unknown):boolean{
  return error instanceof Error&&'code' in error&&error.code==='ENOENT';
}
function artifactRow(row:unknown):row is ArtifactRow{
  return record(row)&&typeof row.path==='string'&&typeof row.size==='number'&&Number.isSafeInteger(row.size)&&
    row.size>=64&&row.size<=maxBytes&&typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256);
}
const format='mvw-trust-native-rust-release';
const abi=3;
const built='native-storage/target/release-artifact/trust_storage.node';
const packaged='native-storage/runtime/trust_storage.node';
const maxBytes=16*1024*1024;
// Explicit native formats; each target has its own CI qualification.
const supported=new Set(['linux:x64','linux:arm64','darwin:x64','darwin:arm64','win32:x64']);
const target=Object.freeze({platform:process.platform,architecture:process.arch,nodeApi:6});
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function requireTarget(){
  const nodeApi=Number(process.versions.napi);
  if(!supported.has(process.platform+':'+process.arch)||!Number.isSafeInteger(nodeApi)||nodeApi<target.nodeApi)
    throw Error('Unsupported native Rust release target.');
}
function verifyBinary(bytes:unknown):void{
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
function descriptor(root:string):ArtifactRow|null{
  const location=path.join(root,'RELEASE-MANIFEST.json');
  let info;
  try{info=fs.lstatSync(location);}catch(error){
    if(!missing(error))throw error;
    if(fs.existsSync(path.join(root,packaged)))throw Error('Native Rust SQLite artifact requires a release manifest.');
    return null;
  }
  if(!info.isFile()||info.nlink!==1||info.size>1024*1024)throw Error('Invalid release manifest.');
  const manifest:unknown=JSON.parse(fs.readFileSync(location,'utf8'));
  if(!record(manifest))throw Error('Invalid release manifest.');
  if(typeof manifest.format!=='string'||![format,'mvw-trust-native-http-release'].includes(manifest.format)){
    if(fs.existsSync(path.join(root,packaged)))throw Error('Unexpected packaged native Rust SQLite artifact.');
    return null;
  }
  requireTarget();
  if(!record(manifest.target)||manifest.version!==1||manifest.nativeAbi!==abi||
    manifest.target?.platform!==target.platform||manifest.target?.architecture!==target.architecture||
    manifest.target?.nodeApi!==target.nodeApi||!Array.isArray(manifest.files))
    throw Error('Invalid native Rust release descriptor.');
  const rows:unknown[]=manifest.files.filter((row:unknown)=>record(row)&&row.path===packaged);
  if(rows.length!==1||!artifactRow(rows[0]))throw Error('Invalid native Rust artifact descriptor.');
  return rows[0];
}
function verifyArtifact(root:string,row:ArtifactRow):string{
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
export = Object.freeze({format,abi,built,packaged,maxBytes,target,requireTarget,verifyBinary,descriptor,verifyArtifact});
