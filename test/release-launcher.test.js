'use strict';

const assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const {once}=require('node:events');
const {mkdtemp,readFile,readdir,stat,rm}=require('node:fs/promises');
const http=require('node:http');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {test}=require('node:test');
const {promisify}=require('node:util');
const {openSqlite}=require('../durable-storage');

const invoke=promisify(execFile);
const source=resolve(__dirname,'..');
const launcher=join(source,'start-release.js');
const timeout=20000;
async function scratch(t){
  const room=await mkdtemp(join(tmpdir(),'mvw-release-launch-test-'));
  t.after(()=>rm(room,{recursive:true,force:true,maxRetries:2}));
  return room;
}
const tempEnv=room=>({...process.env,TMPDIR:room,TMP:room,TEMP:room});
async function binary(room,...args){
  return invoke(process.execPath,[launcher,...args],{cwd:room,env:tempEnv(room),timeout});
}
test('install-free release preflight validates real SQLite and loopback, leaves no runtime artifacts',async t=>{
  const room=await scratch(t);
  assert.deepEqual(JSON.parse((await binary(room,'--check')).stdout),{status:'verified',mode:'local-synthetic',storage:'sqlite',workspaceCount:2});
  assert.deepEqual(await readdir(room),[]);
  await assert.rejects(binary(room,'--port','65536'),error=>error.code===1&&error.stderr.startsWith('Usage:'));
  await assert.rejects(binary(room,'--host','0.0.0.0'),error=>error.code===1&&error.stderr.startsWith('Usage:'));
  assert.deepEqual(await readdir(room),[]);
  await assert.rejects(invoke(process.execPath,[launcher,'--check'],{cwd:room,env:tempEnv(source),timeout}),
    error=>error.code===1&&error.stdout===''&&error.stderr.includes('private OS temp folder'));
  const occupied=http.createServer().listen(0,'127.0.0.1');
  await once(occupied,'listening');
  try{
    await assert.rejects(binary(room,'--port',String(occupied.address().port)),
      error=>error.code===1&&error.stdout===''&&error.stderr.includes('loopback port'));
    assert.deepEqual(await readdir(room),[]);
  }finally{await new Promise(resolve=>occupied.close(resolve));}
});

test('release run keeps private fixture access outside source and provisions signed-in features',async t=>{
  const room=await scratch(t);
  const child=spawn(process.execPath,[launcher],{cwd:room,env:{
    ...tempEnv(room),DATA_FILE:join(room,'should-not-exist.json'),TRUST_SQLITE_FILE:join(room,'should-not-exist.sqlite'),
    PORT:'1',TRUST_ATTACHMENT_REVIEW:'unexpected-setting',TRUST_ENABLE_LOCAL_IDENTITY_ADMIN:'0',
  },stdio:['ignore','pipe','pipe']});
  let output='',errors='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',data=>{output+=data;});
  child.stderr.on('data',data=>{errors+=data;});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  done.catch(()=>{});
  const stop=async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await done;
  };
  t.after(stop);
  let timer;
  const launch=await Promise.race([
    new Promise(resolve=>{
      const ready=()=>{if(output.includes('\n')){child.stdout.off('data',ready);resolve(JSON.parse(output.trim()));}};
      child.stdout.on('data',ready);ready();
    }),
    done.then(()=>{throw Error('Release exited during startup: '+errors);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Release did not announce readiness.')),timeout);}),
  ]).finally(()=>clearTimeout(timer));
  assert.equal(launch.status,'ready');
  assert.match(launch.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  assert.equal(launch.accessFile,join(launch.runDirectory,'synthetic-access.json'));
  assert.ok(launch.runDirectory.startsWith(room));
  const roles=JSON.parse(await readFile(launch.accessFile,'utf8'));
  if(process.platform!=='win32'){
    assert.equal((await stat(launch.runDirectory)).mode&0o777,0o700);
    assert.equal((await stat(launch.accessFile)).mode&0o777,0o600);
  }
  assert.equal(roles.mode,'local-synthetic-only');
  assert.ok(Date.parse(roles.validUntil)-Date.now()>7*3600000);
  for(const key of ['staff','requesters','employees','learners'])
    assert.ok(roles[key].every(row=>typeof row.code==='string'&&!output.includes(row.code)&&!errors.includes(row.code)));
  assert.deepEqual(await readdir(room),[launch.runDirectory.split(require('node:path').sep).at(-1)]);
  const req=async(path,status,{body,cookie,workspace}={})=>{
    const response=await fetch(launch.url+path+(workspace?'?workspace='+workspace:''),{
      signal:AbortSignal.timeout(5000),redirect:'error',
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:launch.url,'Content-Type':'application/json'})}
    });
    assert.equal(response.status,status,path);
    return {response,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(account,workspace='harbor')=>{
    const {code}=roles.staff.find(seat=>seat.id===account);
    const {response,cookie}=await req('/api/session/login',200,{body:{account,workspace,code}});
    return {session:await response.json(),cookie,workspace};
  };
  const intake=await login('sample-intake');
  const review=await login('sample-review');
  const admin=await login('sample-identity-admin');
  const investigator=await login('sample-ethics-investigator');
  assert.equal(intake.session.actor,'analyst');
  assert.equal(review.session.actor,'reviewer');
  assert.equal(admin.session.actor,'identity-admin');
  await req('/api/state',401,{workspace:'harbor'});
  await req('/synthetic-access.json',404);
  await req('/workspace.sqlite',404);
  await req('/api/state',403,{...intake,workspace:'orchard'});
  await req('/api/operator/v1/jobs',200,intake);
  await req('/api/data-map/discovery/runs',200,intake);
  await req('/api/identity-admin',200,admin);
  await req('/api/directory-lifecycle',200,admin);
  await req('/api/group-governance',200,admin);
  await req('/api/document-access',200,admin);
  await req('/api/ethics/cases',200,investigator);
  const {response:documents}=await req('/api/governance-documents',200,intake);
  assert.equal((await documents.json()).attachmentRules.manualReview,true);
  const {response:rights}=await req('/api/rights/cases',200,intake);
  assert.deepEqual((await rights.json()).delegation.accounts,['sample-case-operator']);
  for(const path of ['/requester','/employee','/training','/trust-center/sample-harbor'])await req(path,200);
  await req('/api/requester/status',200,{body:{code:roles.requesters.find(x=>x.workspace==='harbor').code}});
  await req('/api/employee/assignments',200,{body:{code:roles.employees.find(x=>x.workspace==='harbor').code}});
  await req('/api/training-learner/list',200,{body:{code:roles.learners.find(x=>x.workspace==='harbor').code}});
  const name='Fictional portable release project';
  await req('/api/projects',200,{...intake,body:{name}});
  await stop();
  if(process.platform!=='win32'){
    assert.equal((await done).code,0);
    assert.ok(!(await readdir(launch.runDirectory)).includes('synthetic-access.json'));
  }
  const db=openSqlite(join(launch.runDirectory,'workspace.sqlite'),{readOnly:true});
  try{
    assert.equal(db.snapshot().mode,'isolated');
    assert.deepEqual(db.scope('workspace:harbor').read('workbench').projects.map(row=>row.name),[name]);
    assert.deepEqual(db.scope('workspace:orchard').read('workbench').projects,[]);
  }finally{db.close();}
});

async function claimedLaunch(t,room,...args){
  const child=spawn(process.execPath,[launcher,...args],{cwd:room,env:tempEnv(room),stdio:['ignore','pipe','pipe']});
  let log='',errors='';
  child.stderr.setEncoding('utf-8').on('data',chunk=>{errors+=chunk;});
  const done=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  done.catch(()=>{});
  const stop=async(signal='SIGTERM')=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill(signal);
    return done;
  };
  t.after(()=>stop());
  let timer;
  const launch=await Promise.race([
    new Promise(resolve=>child.stdout.setEncoding('utf-8').on('data',chunk=>{
      log+=chunk;
      if(log.includes('\n'))resolve(JSON.parse(log.trim()));
    })),
    done.then(()=>{throw new Error('Release did not reach ready: '+errors);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Release did not announce ready.')),timeout);}),
  ]).finally(()=>clearTimeout(timer));
  const access=JSON.parse(await readFile(launch.accessFile,'utf8'));
  const req=async(route,status,{cookie,body,workspace}={})=>{
    const response=await fetch(launch.url+route+(workspace?'?workspace='+workspace:''),{
      signal:AbortSignal.timeout(5000),redirect:'error',
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:launch.url,'Content-Type':'application/json'})}
    });
    const data=await response.json();
    assert.equal(response.status,status,route+': '+JSON.stringify(data));
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(account,status=200)=>{
    const {code}=access.staff.find(seat=>seat.id===account);
    const result=await req('/api/session/login',status,{body:{account,workspace:'harbor',code}});
    return {cookie:result.cookie,workspace:'harbor'};
  };
  return {launch,access,req,login,stop,console:()=>log+errors};
}

test('saved release restarts after interruption, retaining scoped approvals, jobs, exact receipts and fresh sessions',async t=>{
  const {randomBytes,randomUUID}=require('node:crypto');
  const room=await scratch(t);
  const first=await claimedLaunch(t,room);
  const {runDirectory,accessFile}=first.launch;
  assert.match(runDirectory,/mvw-trust-release-/);
  const profile=join(runDirectory,'release-profile.json');
  const secrets=JSON.parse(await readFile(profile,'utf8'));
  if(process.platform!=='win32')assert.equal((await stat(profile)).mode&0o777,0o600);
  assert.doesNotMatch(first.console(),new RegExp(secrets.seed));

  const a=await first.login('sample-intake'),r=await first.login('sample-review'),c=await first.login('sample-case-operator');
  const project='Verified local release continuation';
  await first.req('/api/projects',200,{...a,body:{name:project}});
  const cases=(await first.req('/api/rights/cases',200,{...a,body:{
    kind:'access',owner:'case-operator',days:9,note:'Fictional account-scoped restart fixture'
  }})).data;
  const rights=cases.cases[0];
  await first.req('/api/rights/cases/'+rights.id+'/delegation',200,{...a,body:{
    operation:'delegate',reason:'case-assignment',account:'sample-case-operator',expectedRevision:rights.revision
  }});
  const jobPath='/api/operator/v1/jobs';
  const submitted={action:'rights.case.status',args:{caseId:rights.id},idempotencyKey:randomUUID()};
  const queued=(await first.req(jobPath,201,{...a,body:submitted})).data.job;

  const requesterCode=first.access.requesters.find(x=>x.workspace==='harbor').code;
  const requesterReceipt=(await first.req('/api/requester/intake',200,{body:{code:requesterCode,kind:'correction'}})).data;

  const docs='/api/governance-documents/records';
  const draft=(await first.req(docs,200,{...a,body:{kind:'policy',title:'Fictional restorable policy',
    content:'Synthetic policy text for retaining an exact receipt.',links:[],expectedRevision:0}})).data.documents[0];
  const edition=draft.revisions[0],revision=docs+'/'+draft.id+'/revisions/'+edition.id;
  await first.req(revision+'/submit',200,{...a,body:{expectedRevision:1}});
  await first.req(revision+'/publish',200,{...r,body:{expectedRevision:2,note:'Fictional approval'}});
  const employee=first.access.employees.find(x=>x.workspace==='harbor');
  await first.req('/api/employee-attestations',200,{...a,body:{employee:employee.alias,document:draft.id,edition:edition.id,hash:edition.contentHash}});
  const attendance='/api/employee/assignments',attest='/api/employee/attest';
  const assignment=(await first.req(attendance,200,{body:{code:employee.code}})).data.assignments[0];
  const confirmation={code:employee.code,assignment:assignment.assignment,edition:edition.id,hash:edition.contentHash,confirm:true};
  const policyReceipt=(await first.req(attest,200,{body:confirmation})).data.assignments[0].receipt;

  for(let n=0;n<28;n++)await first.req('/api/projects',200,{...a,body:{
    name:'Fictional persisted project '+n,description:'Fictional archived test context. '.repeat(50)
  }});
  assert.ok(Buffer.byteLength(JSON.stringify((await first.req('/api/state',200,a)).data))>64*1024,
    'saved workspace should exceed the launch probe’s normal JSON body cap');
  const before=await readFile(accessFile,'utf8');
  await assert.rejects(binary(room,'--resume',runDirectory),error=>error.code===1&&error.stdout===''&&error.stderr.includes('already running'));
  assert.equal(await readFile(accessFile,'utf8'),before);
  assert.equal((await first.req('/api/state',200,a)).data.projects[0].name,project);
  await first.stop('SIGKILL');
  // The run was not cleaned up, but terminating the process did release SQLite’s lease.
  assert.equal(await readFile(accessFile,'utf8'),before);

  const resumed=await claimedLaunch(t,room,'--resume',runDirectory);
  assert.equal(resumed.launch.resumed,true);
  assert.equal(resumed.launch.runDirectory,runDirectory);
  assert.notEqual(resumed.access.validUntil,first.access.validUntil);
  assert.deepEqual(resumed.access.staff.map(x=>x.code),first.access.staff.map(x=>x.code));
  assert.deepEqual(resumed.access.requesters.map(x=>x.code),first.access.requesters.map(x=>x.code));
  assert.doesNotMatch(resumed.console(),new RegExp(secrets.seed));
  await resumed.req('/api/state',401,a);
  const intake=await resumed.login('sample-intake'),operator=await resumed.login('sample-case-operator');
  assert.notEqual(intake.cookie,a.cookie);
  assert.notEqual(operator.cookie,c.cookie);
  assert.equal((await resumed.req('/api/state',200,intake)).data.projects[0].name,project);
  assert.deepEqual((await resumed.req('/api/rights/cases',200,operator)).data.cases.map(row=>row.id),[rights.id]);
  const jobs=(await resumed.req(jobPath,200,intake)).data.jobs;
  assert.equal(jobs.find(x=>x.id===queued.id).status,'queued');
  const run=(await resumed.req(jobPath+'/'+queued.id+'/run',200,{...intake,body:{}})).data.job;
  assert.equal(run.result.caseId,rights.id);
  assert.deepEqual((await resumed.req('/api/requester/status',200,{body:{code:requesterCode}})).data,requesterReceipt);
  assert.deepEqual((await resumed.req(attest,200,{body:confirmation})).data.assignments[0].receipt,policyReceipt);
  const admin=await resumed.login('sample-identity-admin');
  await resumed.req('/api/identity-admin',200,{...admin,body:{target:'sample-intake',operation:'disable',reason:'access-review',expectedRevision:0}});
  await resumed.stop();

  await assert.rejects(binary(room,'--check','--resume',runDirectory),error=>error.code===1&&error.stderr.startsWith('Usage:'));
  const {rename,writeFile}=require('node:fs/promises');
  await rename(profile,profile+'.preserved');
  await writeFile(profile,'{"schemaVersion":1,"mode":"another-product","seed":"fake"}',{mode:0o600});
  const database=join(runDirectory,'workspace.sqlite'),saved=await readFile(database);
  await assert.rejects(binary(room,'--resume',runDirectory),error=>error.code===1&&error.stdout==='');
  assert.deepEqual(await readFile(database),saved);
  await writeFile(profile,JSON.stringify({...secrets,seed:randomBytes(32).toString('hex')}));
  await assert.rejects(binary(room,'--resume',runDirectory),error=>error.code===1&&error.stdout==='');
  assert.deepEqual(await readFile(database),saved);
  await rename(profile+'.preserved',profile);
  const third=await claimedLaunch(t,room,'--resume',runDirectory);
  await third.login('sample-intake',401); // Readiness found another active seat without resetting the suspension.
  const thirdReview=await third.login('sample-review');
  assert.equal((await third.req('/api/state',200,thirdReview)).data.projects[0].name,project);
  const db=openSqlite(database,{readOnly:true});
  try{
    const stored=db.scope('workspace:harbor').read('workbench').operatorJobs;
    assert.deepEqual(stored.find(row=>row.id===queued.id).result,run.result);
  }finally{db.close();}
  await third.stop();
});
