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
const format='mvw-trust-native-http-release',abi=1,maxBytes=16*1024*1024;
const built='native-http/target/release-artifact/trust-http',packaged='native-http/runtime/trust-http';
function requireTarget(){
  if(process.platform!=='linux'||process.arch!=='x64')throw Error('Native HTTP releases currently require Linux x64.');
}
function verifyBinary(bytes:unknown):void{
  requireTarget();
  if(!Buffer.isBuffer(bytes)||bytes.length<64||bytes.length>maxBytes||
    !bytes.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))||
    ![2,3].includes(bytes.readUInt16LE(16))||bytes.readUInt16LE(18)!==62)
    throw Error('Invalid native HTTP executable format.');
}
function descriptor(root:string):ArtifactRow|null{
  const file=path.join(root,'RELEASE-MANIFEST.json');
  let stat;
  try{stat=fs.lstatSync(file);}catch(error){
    if(!missing(error))throw error;
    if(fs.existsSync(path.join(root,packaged)))throw Error('Native HTTP artifact requires a release manifest.');
    return null;
  }
  if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw Error('Invalid release manifest.');
  const manifest:unknown=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!record(manifest))throw Error('Invalid release manifest.');
  if(manifest.format!==format){
    if(fs.existsSync(path.join(root,packaged)))throw Error('Unexpected native HTTP artifact.');
    return null;
  }
  requireTarget();
  if(!record(manifest.target)||manifest.version!==1||manifest.httpAbi!==abi||manifest.target?.platform!=='linux'||manifest.target?.architecture!=='x64'||
    !Array.isArray(manifest.files))throw Error('Invalid native HTTP release descriptor.');
  const rows:unknown[]=manifest.files.filter((row:unknown)=>record(row)&&row.path===packaged);
  if(rows.length!==1||!artifactRow(rows[0]))throw Error('Invalid native HTTP artifact descriptor.');
  return rows[0];
}
function bytesFor(root:string,row:ArtifactRow):Buffer{
  for(const folder of ['native-http','native-http/runtime'])
    if(!fs.lstatSync(path.join(root,folder)).isDirectory())throw Error('Unsafe native HTTP artifact directory.');
  const location=path.join(root,packaged),stat=fs.lstatSync(location);
  if(!stat.isFile()||stat.nlink!==1||stat.size!==row.size)throw Error('Native HTTP artifact size mismatch.');
  const bytes=fs.readFileSync(location);
  if(bytes.length!==row.size||createHash('sha256').update(bytes).digest('hex')!==row.sha256)
    throw Error('Native HTTP artifact digest mismatch.');
  verifyBinary(bytes);return bytes;
}
export = Object.freeze({format,abi,maxBytes,built,packaged,requireTarget,verifyBinary,descriptor,bytesFor});
