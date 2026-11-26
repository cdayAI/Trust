'use strict';
const {spawnSync}=require('node:child_process');
const {join}=require('node:path');
const root=join(__dirname,'..');
function run(command,args,env=process.env){
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(command+' failed with status '+result.status);
}
try{
  if(process.argv[2]==='build'){
    run('cargo',['+1.85.1','build','--manifest-path','rust-core/Cargo.toml','--target-dir','rust-core/target',
      '--locked','--offline','--release','--target','wasm32-unknown-unknown']);
    run(process.execPath,['-e',"if(!require('./rust-core').enabled)throw Error('Rust core is inactive')"],{...process.env,TRUST_RUST_CORE:'required'});
  }else if(process.argv[2]==='test'){
    run(process.execPath,['--test','--test-concurrency=2','--test-timeout=90000',
      'test/rust-core.test.js','test/governance-document-attachments.test.js','test/api.test.js',
      'test/rights-deadline-policy.test.js','test/fixture-migration.test.js','test/data-dictionary.test.js',
      'test/discovery-import.test.js','test/processing-register.test.js','test/evidence-disposition.test.js','test/attachment-binary-batch.test.js','test/workflow-engine.test.js','test/workflow-http.test.js','test/access-policy.test.js','test/workspace-access.test.js','test/document-review-seats.test.js','test/vendor-engagements.test.js','test/reporting.test.js','test/reporting-runs.test.js','test/report-schedules.test.js'],
      {...process.env,TRUST_RUST_CORE:'required'});
  }else throw Error('Usage: npm run build:rust | npm run test:rust');
}catch(error){console.error(error.message);process.exitCode=1;}
