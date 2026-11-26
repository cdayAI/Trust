'use strict';
const {spawnSync}=require('node:child_process');
const {join,dirname}=require('node:path');
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const root=join(__dirname,'..'),folder=join(root,'native-storage','target'),artifact=join(folder,'release-artifact','trust_storage.node');
function run(command,args,env=process.env){
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(command+' failed with status '+result.status);
}
function build(){
  run('cargo',['+1.95.0','build','--manifest-path','native-storage/Cargo.toml','--target-dir','native-storage/target','--locked','--release']);
  const name=process.platform==='win32'?'trust_storage.dll':process.platform==='darwin'?'libtrust_storage.dylib':'libtrust_storage.so';
  const source=join(folder,'release',name),stat=fs.lstatSync(source);
  if(!stat.isFile()||stat.size<1||stat.size>64*1024*1024)throw Error('Invalid native build artifact');
  fs.mkdirSync(dirname(artifact),{recursive:true});
  if(!fs.lstatSync(dirname(artifact)).isDirectory())throw Error('Invalid native artifact directory');
  const temporary=artifact+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,fs.readFileSync(source),{flag:'wx',mode:0o644,flush:true});fs.renameSync(temporary,artifact);}
  finally{fs.rmSync(temporary,{force:true});}
  const binding=require(artifact);
  if(binding.storageAbi()!==require('../native-storage-abi').abi||typeof binding.NativeStorage!=='function'||typeof binding.NativeLease!=='function'||typeof binding.runtimeProbe!=='function')throw Error('Native ABI mismatch');
  console.log(JSON.stringify({driver:'rust',sqlite:binding.sqliteVersion(),platform:process.platform,arch:process.arch}));
}
function test(){
  const env={...process.env,TRUST_SQLITE_DRIVER:'rust',TRUST_RUST_CORE:'required'};
  run(process.execPath,['--test','--test-concurrency=2','--test-timeout=90000','test/native-storage.test.js','test/durable-storage.test.js','test/storage-encryption.test.js','test/evidence-recovery.test.js','test/local-performance.test.js','test/fixture-migration.test.js','test/workflow-http.test.js','test/operational-health.test.js','test/release-launcher.test.js'],env);
  run(process.execPath,['scripts/verify-sqlite-resilience.js'],env);
  run(process.execPath,['scripts/verify-sqlite-concurrency-local.js'],env);
}
try{if(process.argv[2]==='build')build();else if(process.argv[2]==='test')test();else throw Error('Use build or test');}
catch(error){console.error(error.message);process.exitCode=1;}
