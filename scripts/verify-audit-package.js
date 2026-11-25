'use strict';

const {constants,openSync,fstatSync,readSync,closeSync}=require('node:fs');
const {verifyBytes,MAX_BYTES}=require('../audit-verification');
const usage='Usage: node scripts/verify-audit-package.js PACKAGE.json [--expected-manifest-sha256 HEX_SHA256]';
function readBounded(file){
  // Do not wait for another process to write to a pipe supplied as input.
  const fd=openSync(file,constants.O_RDONLY|(constants.O_NONBLOCK??0));
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>MAX_BYTES)throw Error('Expected a regular audit package file no larger than 8 MiB.');
    const bytes=Buffer.alloc(stat.size+1);
    let offset=0,count;
    while(offset<bytes.length&&(count=readSync(fd,bytes,offset,bytes.length-offset,null)))offset+=count;
    if(offset!==stat.size)throw Error('The audit package changed while it was being read.');
    return bytes.subarray(0,offset);
  }finally{closeSync(fd)}
}
try{
  const [file,flag,expected,...extra]=process.argv.slice(2);
  if(!file||extra.length||flag!==undefined&&(flag!=='--expected-manifest-sha256'||!expected||!/^[a-f0-9]{64}$/.test(expected)))throw Error(usage);
  const result=verifyBytes(readBounded(file),{expectedManifestSha256:expected});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){
  process.stderr.write('Audit package verification failed: '+error.message+'\n');
  process.exitCode=1;
}
