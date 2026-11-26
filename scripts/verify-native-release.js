'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const root=resolve(__dirname,'..');
const contract=require('../native-storage-abi');
const env={...process.env};
delete env.TRUST_RUST_CORE;delete env.TRUST_SQLITE_DRIVER;
const npm=process.env.npm_execpath;
if(!npm)throw Error('Run through npm run verify:native-release.');
function run(command,args,cwd=root,extra={},deny=false){
  const result=spawnSync(command,args,{cwd,env:{...env,...extra},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  if(deny){assert.notEqual(result.status,0,'Expected refusal: '+args.join(' '));return;}
  assert.equal(result.status,0,(result.stderr??'').slice(-4000));
  return result.stdout;
}
const node=(args,cwd,extra,deny)=>run(process.execPath,args,cwd,extra,deny);
function main(){
  contract.requireTarget();
  const scratch=fs.mkdtempSync(join(tmpdir(),'trust-native-release-'));
  try{
    const one=join(scratch,'first.tgz'),two=join(scratch,'second.tgz');
    node([npm,'run','release:native-rust','--',one]);node([npm,'run','release:native-rust','--',two]);
    assert.deepEqual(fs.readFileSync(one),fs.readFileSync(two),'reproducible native archive');
    run('tar',['-xzf',one,'-C',scratch]);
    const dir=join(scratch,'package');
    const verify=()=>node([npm,'run','release:verify'],dir);
    verify();
    const query="const s=require('./storage-driver'),r=require('./rust-core');if(s.selectedStorageDriver()!=='rust'||!r.enabled)process.exit(1);process.stdout.write(s.probeStorageDriver());";
    const sqlite=node(['-e',query],dir).trim();assert.match(sqlite,/^3\.\d+\.\d+$/);
    node(['start-release.js','--check'],dir);
    node(['-e',"require('./storage-driver')"],dir,{TRUST_SQLITE_DRIVER:'node'},true);
    node(['-e',"require('./rust-core')"],dir,{TRUST_RUST_CORE:'off'},true);
    const artifact=join(dir,contract.packaged),bytes=fs.readFileSync(artifact);
    const damaged=Buffer.from(bytes);damaged[damaged.length-1]^=1;
    fs.writeFileSync(artifact,damaged);
    node(['scripts/package-release.js','--verify-extracted'],dir,{},true);
    node(['-e',"require('./storage-driver')"],dir,{},true);
    fs.rmSync(artifact);
    node(['scripts/package-release.js','--verify-extracted'],dir,{},true);
    node(['-e',"require('./storage-driver')"],dir,{},true);
    fs.writeFileSync(artifact,bytes);verify();
    const manifest=join(dir,'RELEASE-MANIFEST.json'),saved=fs.readFileSync(manifest);
    const wrong=JSON.parse(saved);wrong.target.architecture=wrong.target.architecture==='x64'?'arm64':'x64';
    fs.writeFileSync(manifest,JSON.stringify(wrong));
    node(['scripts/package-release.js','--verify-extracted'],dir,{},true);
    node(['-e',"require('./storage-driver')"],dir,{},true);
    fs.writeFileSync(manifest,saved);verify();
    console.log(JSON.stringify({status:'verified',target:contract.target,sqlite,archiveBytes:fs.statSync(one).size}));
  }finally{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:3});}
}
try{main();}catch(error){console.error(error.message);process.exitCode=1;}
