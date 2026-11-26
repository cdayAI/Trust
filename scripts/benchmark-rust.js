'use strict';
// Same synthetic workload and runner, alternating mode order across trials.
// Do not infer production performance or require an arbitrary speedup.
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {join}=require('node:path');
const root=join(__dirname,'..');
const modes=[
  {name:'js-node',TRUST_RUST_CORE:'off',TRUST_SQLITE_DRIVER:'node',TRUST_SNAPSHOT_CACHE:'off'},
  {name:'wasm-node',TRUST_RUST_CORE:'required',TRUST_SQLITE_DRIVER:'node',TRUST_SNAPSHOT_CACHE:'off'},
  {name:'wasm-native',TRUST_RUST_CORE:'required',TRUST_SQLITE_DRIVER:'rust',TRUST_SNAPSHOT_CACHE:'off'},
  {name:'wasm-native-cached',TRUST_RUST_CORE:'required',TRUST_SQLITE_DRIVER:'rust',TRUST_SNAPSHOT_CACHE:'on'}
];
const workload=['--backend','sqlite','--records','400','--samples','24','--concurrency','2'];
function trial(mode){
  const {name,...settings}=mode;
  const env={...process.env,...settings};
  const result=spawnSync(process.execPath,['scripts/benchmark-local.js',...workload],{
    cwd:root,env,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  return {mode:name,report};
}
const median=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
function main(){
  const trials=[];
  for(let round=0;round<3;round++)for(let offset=0;offset<modes.length;offset++)
    trials.push({round:round+1,...trial(modes[(round+offset)%modes.length])});
  const rows=[];
  for(const result of trials[0].report.results)for(const metric of result.metrics){
    const values=Object.fromEntries(modes.map(({name})=>{
      const found=trials.filter(t=>t.mode===name).map(t=>t.report.results.find(r=>r.mode===result.mode&&r.backend===result.backend).metrics.find(m=>m.name===metric.name));
      return [name,{p50Ms:median(found.map(x=>x.p50Ms)),p95Ms:median(found.map(x=>x.p95Ms)),requestsPerSecond:median(found.map(x=>x.requestsPerSecond))}];
    }));
    rows.push({workspace:result.mode,operation:metric.name,values,
      nativeP95Ratio:Number((values['wasm-native'].p95Ms/values['js-node'].p95Ms).toFixed(3)),
      cachedP95Ratio:Number((values['wasm-native-cached'].p95Ms/values['wasm-native'].p95Ms).toFixed(3))});
  }
  const report={schemaVersion:1,scope:'Synthetic local SQLite workloads; medians of three alternating same-runner trials.',
    platform:process.platform,architecture:process.arch,node:process.versions.node,workload,rows,trials};
  console.log(JSON.stringify(report,null,2));
  if(process.env.GITHUB_STEP_SUMMARY){
    const lines=['## Rust vs reference — synthetic workload','',
      '| Workspace | Operation | JS/Node p95 ms | Wasm/Node p95 ms | Wasm/native p95 ms | Cached native p95 ms | Cache/native ratio |','| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...rows.map(r=>'| '+[r.workspace,r.operation,r.values['js-node'].p95Ms,r.values['wasm-node'].p95Ms,r.values['wasm-native'].p95Ms,r.values['wasm-native-cached'].p95Ms,r.cachedP95Ratio].join(' | ')+' |')];
    require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
  }
}
try{main();}catch(error){console.error(error.message);process.exitCode=1;}
