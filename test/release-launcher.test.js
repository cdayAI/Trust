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
  await req('/api/identity-admin',200,admin);
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
