'use strict';
const {createHash}=require('node:crypto');
const abi=6;
const cargoOutput='rust-core/target/wasm32-unknown-unknown/release/trust_core.wasm';
// Cargo may hard-link its output to deps/. Package a distinct, verified file.
const built='rust-core/target/release-artifact/trust_core.wasm';
const packaged='rust-core/runtime/trust_core.wasm';
const format='mvw-trust-rust-release';
const required=['trust_reserve','trust_raster','trust_trace','trust_acyclic','trust_due_day','trust_zip','trust_batch_header','trust_batch_layout',
  'trust_workflow_permission','trust_risk_score','trust_link_status','trust_reductions','trust_account_live','trust_cookie',
  'trust_report','trust_routes_init','trust_authorize','trust_revision','trust_transition','trust_answer'];
const maxBytes=4*1024*1024;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function instantiate(bytes){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxBytes)throw Error('Invalid Rust core artifact size.');
  const module=new WebAssembly.Module(bytes);
  if(WebAssembly.Module.imports(module).length)throw Error('The Rust core must not import host capabilities.');
  const exports=new WebAssembly.Instance(module,{}).exports;
  if(!(exports.memory instanceof WebAssembly.Memory)||typeof exports.trust_abi!=='function'||exports.trust_abi()!==abi||
    required.some(key=>typeof exports[key]!=='function'))throw Error('Incompatible Rust core ABI. Rebuild the Rust core.');
  return exports;
}
module.exports=Object.freeze({abi,cargoOutput,built,packaged,format,maxBytes,sha256,instantiate});
