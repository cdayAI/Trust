'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createServer } = require('../server');
const { openSqlite } = require('../durable-storage');
const rights = require('../rights-workflow');
const { codeHash } = require('../workspace-access');

const usage = 'Usage: node scripts/benchmark-local.js [--backend all|json|sqlite] [--records 1..1500] [--samples 8..100] [--concurrency 1..4]';
const roles = ['analyst', 'reviewer', 'case-operator'];
const INTAKE = 'Local benchmark only. This synthetic note excludes names, identifiers, evidence, credentials, contact details, records from work, and attachments.';
const limits = {records:[1,1500], samples:[8,100], concurrency:[1,4]};

function options(args) {
  const opts = {backend:'all', records:900, samples:32, concurrency:1};
  const seen = new Set();
  for (let i=0; i<args.length; i+=2) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : '';
    const raw = args[i+1];
    if (!Object.hasOwn(opts,name)||raw===undefined||seen.has(name)) throw new Error(usage);
    seen.add(name);
    if (name==='backend') {
      if (!['all','json','sqlite'].includes(raw)) throw new Error(usage);
      opts[name]=raw;
    } else {
      const [min,max]=limits[name];
      if (!/^[1-9][0-9]*$/.test(raw)||Number(raw)<min||Number(raw)>max) throw new Error(usage);
      opts[name]=Number(raw);
    }
  }
  return opts;
}

function fixture(count) {
  const state = {version:1,actors:roles.map(id=>({id,name:'Synthetic '+id,role:id})),projects:[],vendors:[],assessments:[],handoff:[],audit:[]};
  const at='2026-01-02T03:04:05.678Z';
  const audit=(s,actor,action,projectId,entityId,details)=>s.audit.push({
    id:randomUUID(),sequence:s.audit.length+1,at,actor,action,projectId,entityId,details
  });
  for (let i=0;i<count;i++) {
    const id=randomUUID(), name='Synthetic project '+i, description=INTAKE;
    state.projects.push({id,name,description});
    state.handoff.push({id:randomUUID(),projectId:id,status:'ready',attempts:0,error:null,receipt:null,request:null});
    audit(state,'analyst','project.created',id,id,{name,description});
    const owner=i%2===0?'case-operator':'analyst';
    rights.change(state,['rights','cases'],'analyst',{kind:i%2===0?'access':'correction',owner,days:14,note:INTAKE},audit);
    if (i%4===0) rights.change(state,['rights','cases',state.rightsCases.at(-1).id,'verify'],'reviewer',
      {expectedRevision:1,note:INTAKE},audit);
  }
  return state;
}

const pctl = (ascending,p) => ascending[Math.ceil(ascending.length*p)-1];
const round = value => Number(value.toFixed(3));
async function sample(name,action,{samples,concurrency},bytes) {
  const warmups=4;
  for(let i=0;i<warmups;i++)await action();
  const times=[];
  const began=performance.now();
  async function runner(worker){
    for(let i=worker;i<samples;i+=concurrency){
      const start=performance.now();
      await action();
      times.push(performance.now()-start);
    }
  }
  await Promise.all(Array.from({length:concurrency},(_,i)=>runner(i)));
  const elapsed=performance.now()-began;
  times.sort((a,b)=>a-b);
  return {name,samples,warmups,p50Ms:round(pctl(times,.5)),p95Ms:round(pctl(times,.95)),p99Ms:round(pctl(times,.99)),
    requestsPerSecond:round(samples*1000/elapsed),lastResponseBytes:bytes()};
}

async function benchmark(backend,mode,base,seed,opts,signal) {
  const dest=join(base,backend+'-'+mode);
  fs.mkdirSync(dest,{mode:0o700});
  const isolated=mode==='isolated', scope=isolated?'workspace:alpha':'demo';
  const accountIds=Object.fromEntries(roles.map(role=>[role,'sample-'+role]));
  const codes=Object.fromEntries(roles.map(role=>[role,randomBytes(32).toString('base64url')]));
  const workbench = join(dest,'workspaces');
  const dataFile = join(dest,'explicit-demo-state.json');
  const sqliteFile = backend==='sqlite' ? join(dest,'snapshot.sqlite') : undefined;
  const options={dataFile,sqliteFile};
  if(isolated)options.isolated={
    root:workbench,
    accounts:roles.map(role=>({id:accountIds[role],codeHash:codeHash(codes[role]),memberships:{alpha:role,...(role==='analyst'?{beta:role}:{})}})),
    workspaces:[{id:'alpha',label:'Synthetic Alpha'},{id:'beta',label:'Synthetic Beta'}]
  };

  if(sqliteFile){
    const db=openSqlite(sqliteFile);
    try { db.requireMode(mode); db.import(mode,[{scope,kind:'workbench',generation:1,payload:seed}]); }
    finally { db.close(); }
  } else {
    const file=isolated?join(workbench,'alpha','state.json'):dataFile;
    if(isolated)fs.mkdirSync(join(workbench,'alpha'),{recursive:true,mode:0o700});
    fs.writeFileSync(file,JSON.stringify(seed,null,2)+'\n',{mode:0o600,flag:'wx'});
  }

  const started=performance.now();
  const server=createServer(options).listen(0,'127.0.0.1');
  try {
    await once(server,'listening',{signal});
    const startupMs=round(performance.now()-started);
    const origin='http://127.0.0.1:'+server.address().port;
    const cookies={};
    let lastBytes=0;
    async function api(route,role,{body,status=200,workspace='alpha'}={}) {
      const url = new URL('/api/'+route,origin);
      if (isolated&&workspace!==null)url.searchParams.append('workspace',workspace);
      const response=await fetch(url,{
        signal,redirect:'error',method:body===undefined?'GET':'POST',
        headers:{...(cookies[role]?{cookie:cookies[role]}:{}),...(!isolated&&role?{'x-demo-actor':role}:{}),
          ...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)
      });
      const responseText=await response.text();
      const value=JSON.parse(responseText);
      lastBytes=Buffer.byteLength(responseText);
      assert.equal(response.status,status,mode+'/'+backend+' '+route+' returned unexpected status');
      return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    if(isolated){
      for(const role of roles){
        const {value,cookie}=await api('session/login',role,{workspace:null,body:{account:accountIds[role],code:codes[role],workspace:'alpha'}});
        assert.equal(value.actor,role);
        assert.ok(cookie);
        cookies[role]=cookie;
      }
      await api('work-queue','case-operator',{status:403});
      await api('reporting','case-operator',{status:403});
      await api('my-work','analyst',{workspace:'beta',status:403});
      const personal=await api('my-work','case-operator');
      assert.equal(personal.value.tasks.length,Math.ceil(opts.records/4));
      assert.ok(personal.value.tasks.every(task=>task.recordLabel==='access request'&&task.actionLabel==='Begin mock fulfillment'));
      assert.ok(!JSON.stringify(personal.value).includes(INTAKE));
    }
    let writes=0;
    const groups=[
      ['workbench-state',()=>api('state','analyst')],
      ['reporting-records',()=>api('reporting?dataset=records&group=workflow','reviewer')],
      ['reporting-activity',()=>api('reporting?dataset=activity&group=day','reviewer')],
      ['reviewer-filtered-queue',()=>api('work-queue?owner=reviewer&workflow=rights','reviewer')],
      ...(isolated?[
        ['isolated-session-check',()=>api('session','case-operator',{workspace:null})],
        ['assigned-case-operator-work',()=>api('my-work','case-operator')]
      ]:[]),
      ['case-intake-write',()=>api('rights/cases','analyst',{body:{kind:'portability',owner:'analyst',days:14,
        note:'Synthetic benchmark case write '+(++writes)}})]
    ];
    const metrics=[];
    for(const [name,action] of groups)
      metrics.push(await sample(name,action,opts,()=>lastBytes));
    const final=await api('rights/cases','analyst');
    assert.equal(final.value.cases.length,opts.records+writes);
    assert.equal(final.value.cases.filter(row=>row.kind==='portability').length,writes);
    return {backend,mode,startupMs,seedUtf8Bytes:Buffer.byteLength(JSON.stringify(seed)),writes,metrics};
  } finally {
    server.closeAllConnections();
    if(server.listening)await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
  }
}

async function main(args) {
  if(args.includes('--help')&&args.length===1){console.log(usage);return;}
  const opts=options(args);
  const path=fs.mkdtempSync(join(tmpdir(),'mvw-local-bench-'));
  const signal=AbortSignal.timeout(60000);
  try {
    const seed=fixture(opts.records);
    const results=[];
    for(const backend of opts.backend==='all'?['json','sqlite']:[opts.backend])
      for(const mode of ['demo','isolated'])
        results.push(await benchmark(backend,mode,path,seed,opts,signal));
    console.log(JSON.stringify({schemaVersion:1,scope:'synthetic-only, same-host loopback (no external services)',
      node:process.versions.node,platform:process.platform,arch:process.arch,options:opts,results},null,2));
  } finally {fs.rmSync(path,{recursive:true,force:true});}
}
main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
