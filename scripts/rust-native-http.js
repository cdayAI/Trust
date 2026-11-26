'use strict';
const fs=require('node:fs');
const {join,dirname}=require('node:path');
const {spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const root=join(__dirname,'..');
function run(command,args,env=process.env){
  const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(command+' failed with status '+result.status);
}
function build(){
  if(process.platform!=='linux')throw Error('Native HTTP listener currently requires Linux.');
  run('cargo',['+1.95.0','build','--manifest-path','native-http/Cargo.toml','--target-dir','native-http/target','--locked','--release']);
  const source=join(root,'native-http','target','release','trust-http');
  const target=join(root,'native-http','target','release-artifact','trust-http');
  fs.mkdirSync(dirname(target),{recursive:true});
  if(!fs.lstatSync(dirname(target)).isDirectory())throw Error('Unsafe native HTTP artifact directory.');
  const temporary=target+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,fs.readFileSync(source),{flag:'wx',mode:0o700,flush:true});fs.renameSync(temporary,target);}
  finally{fs.rmSync(temporary,{force:true});}
}
try{
  if(process.argv[2]==='build')build();
  else if(process.argv[2]==='test'){
    run(process.execPath,['--test','--test-concurrency=1','--test-timeout=90000','test/native-http.test.js','test/release-launcher.test.js'],
      {...process.env,TRUST_HTTP_TRANSPORT:'rust',TRUST_RUST_CORE:'required',TRUST_SQLITE_DRIVER:'rust'});
  }else throw Error('Usage: npm run build:rust-http | npm run test:rust-http');
}catch(error){console.error(error.message);process.exitCode=1;}
