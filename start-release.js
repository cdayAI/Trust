'use strict';

const {createHmac,randomBytes}=require('node:crypto');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const http=require('node:http');
const {tmpdir}=require('node:os');
const {basename,isAbsolute,join,relative,resolve,sep}=require('node:path');
const {checkRuntime}=require('./scripts/runtime-check');

const host='127.0.0.1';
const leaseTime=8*60*60*1000;
const usage='Usage: node start-release.js [--port 0–65535] [--check | --resume RUN_DIRECTORY]';
const profileName='release-profile.json';
const lockName='release-lease.sqlite';
const regions=[{id:'harbor',label:'Fictional Harbor'},{id:'orchard',label:'Fictional Orchard'}];

function argumentsFor(args){
  if(args.length===1&&args[0]==='--help')return {help:true};
  let port,check=false,resume;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--check'&&!check)check=true;
    else if(args[i]==='--resume'&&resume===undefined){
      const value=args[++i];
      if(!value?.trim()||value.startsWith('--'))throw new Error(usage);
      resume=value;
    }else if(args[i]==='--port'&&port===undefined){
      const value=args[++i];
      if(typeof value!=='string'||value.trim()!==value||!/^\d{1,5}$/.test(value)||Number(value)>65535)
        throw new Error(usage);
      port=Number(value);
    }else throw new Error(usage);
  }
  if(check&&resume)throw new Error(usage);
  return {port:port??0,check,resume};
}
function derive(seed,label,encoding='base64url'){
  return createHmac('sha256',Buffer.from(seed,'hex')).update('mvw-trust-release/v1/'+label).digest(encoding);
}
function localFixture(room,seed,validUntil){
  const {codeHash}=require('./workspace-access');
  const scopes=regions.map(x=>x.id);
  const staff=[
    ['sample-intake',{harbor:'analyst',orchard:'reviewer'}],
    ['sample-review',{harbor:'reviewer'}],
    ['sample-orchard',{orchard:'analyst'}],
    ['sample-publisher',{harbor:'publisher',orchard:'publisher'}],
    ['sample-case-operator',{harbor:'case-operator',orchard:'case-operator'}],
    ['sample-identity-admin',{harbor:'identity-admin',orchard:'identity-admin'}],
    ['sample-ethics-investigator',{harbor:'ethics-investigator',orchard:'ethics-investigator'}],
    ['sample-ethics-reviewer',{harbor:'ethics-reviewer',orchard:'ethics-reviewer'}],
  ].map(([id,memberships])=>({id,memberships,code:derive(seed,'staff/'+id),validUntil}));
  const requesters=scopes.map(workspace=>({id:'request-'+workspace,workspace,alias:'sample-reader-'+workspace,
    code:derive(seed,'requester/'+workspace),expiresAt:validUntil}));
  const employees=scopes.map(workspace=>({workspace,alias:'sample-staff-'+workspace,code:derive(seed,'employee/'+workspace),expiresAt:validUntil}));
  const learners=scopes.map(workspace=>({workspace,alias:'sample-learner-'+workspace,code:derive(seed,'learner/'+workspace),expiresAt:validUntil}));
  const hashed=({code,...seat})=>({...seat,codeHash:codeHash(code)});
  return {
    credentials:{schemaVersion:1,mode:'local-synthetic-only',validUntil:new Date(validUntil).toISOString(),
      staff,requesters,employees,learners},
    isolated:{
      root:join(room,'workspaces'),workspaces:regions,enableIdentityAdmin:true,accounts:staff.map(({validUntil:launchExpiry,...seat})=>hashed(seat)),
      // The listener enforces launch expiry, rather than rolling each account's
      // provisioning fingerprint and revoking previously approved local grants.
      groupApplications:scopes.map(workspace=>({workspace,applications:[
        {id:'sample-case-reference',name:'Fictional Case Reference',summary:'Synthetic group membership and reviewed access exercise.'},
        {id:'sample-service-register',name:'Fictional Service Register',summary:'Fictional local service only. No external systems.'},
      ]})),
      rightsCaseScopeWorkspaces:scopes,documentScopeWorkspaces:scopes,attachmentReviewWorkspaces:scopes,largePdfAttachmentWorkspaces:scopes,
      discoveryRunWorkspaces:scopes,directoryLifecycleWorkspaces:scopes,
      trustCenters:scopes.map(workspace=>({workspace,slug:'sample-'+workspace})),
      requesterGrants:requesters.map(hashed),requesterReleaseWorkspaces:scopes,employeeGrants:employees.map(hashed),trainingGrants:learners.map(hashed),
      employeeSigningKey:derive(seed,'signature/employee','hex'),trainingSigningKey:derive(seed,'signature/learner','hex'),
    },
  };
}
function localRequest(port,path,body,cookie,discardBody=false){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const request=http.request({hostname:host,port,path,method:payload===undefined?'GET':'POST',
      agent:false,signal:AbortSignal.timeout(5000),headers:{
        ...(cookie?{Cookie:cookie}:{}),
        ...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),Origin:'http://'+host+':'+port}),
      }},response=>{
      const chunks=[];
      let size=0;
      response.once('error',reject);
      if(discardBody){
        response.once('end',()=>resolve({status:response.statusCode}));
        response.resume();
        return;
      }
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>64*1024){request.destroy(new Error('Local launch probe response exceeded limit.'));return;}
        chunks.push(chunk);
      });
      response.on('end',()=>{
        let data;
        try{data=JSON.parse(Buffer.concat(chunks));}catch{reject(new Error('Unexpected launch probe response.'));return;}
        resolve({status:response.statusCode,data,cookie:response.headers['set-cookie']?.[0]?.split(';')[0]});
      });
    });
    request.once('error',reject);
    request.end(payload);
  });
}
async function verified(server,credentials,resume){
  const {address,port}=server.address();
  if(address!==host||!port)throw new Error('Local listener was not on loopback.');
  const live=await localRequest(port,'/health/live');
  const ready=await localRequest(port,'/health/ready');
  const anonymous=await localRequest(port,'/api/session');
  if(live.status!==200||live.data.status!=='live'||ready.status!==200||ready.data.status!=='ready'||
    ready.data.checks?.configuration!==true||ready.data.checks?.storage!==true||
    anonymous.status!==200||anonymous.data.authenticated!==false||anonymous.data.mode!=='local-isolated')
    throw new Error('The isolated SQLite workbench did not pass local readiness.');
  for(const {id:workspace} of regions){
    const [other]=regions.map(x=>x.id).filter(x=>x!==workspace);
    const candidates=credentials.staff.filter(seat=>Object.hasOwn(seat.memberships,workspace)).sort((a,b)=>
      Number(b.memberships[workspace]==='analyst')-Number(a.memberships[workspace]==='analyst'));
    let accepted=false;
    for(const {id,code,memberships} of candidates){
      const login=await localRequest(port,'/api/session/login',{account:id,code,workspace});
      if(resume&&login.status===401)continue; // Preserve existing suspensions.
      if(login.status!==200||login.data.workspace!==workspace||login.data.actor!==memberships[workspace]||
        !login.cookie?.startsWith('trust_local_session='))throw new Error('A synthetic login probe failed.');
      const route='/api/state?workspace=';
      const allowed=await localRequest(port,route+workspace,undefined,login.cookie,Boolean(resume));
      const denied=await localRequest(port,route+other,undefined,login.cookie);
      const signout=await localRequest(port,'/api/session/logout',{},login.cookie);
      if(allowed.status!==200||(!resume&&(!Array.isArray(allowed.data.projects)||allowed.data.projects.length))||
        denied.status!==403||signout.status!==200)throw new Error('A synthetic workspace boundary probe failed.');
      accepted=true;break;
    }
    if(!accepted)throw new Error('No active synthetic seat could verify the saved workspace.');
  }
  return 'http://'+host+':'+port;
}
function within(root,filepath){
  const difference=relative(root,filepath);
  return difference===''||(!isAbsolute(difference)&&difference!=='..'&&!difference.startsWith('..'+sep));
}
function privateOwner(stat){
  return process.platform==='win32'||(!(stat.mode&0o077)&&stat.uid===process.getuid());
}
async function privateFile(path,{optional=false}={}){
  let stat;
  try{stat=await fs.lstat(path);}catch(error){if(optional&&error.code==='ENOENT')return;throw error;}
  if(!stat.isFile()||stat.nlink!==1||!privateOwner(stat))throw new Error('Unsafe release file.');
  return stat;
}
async function savedRoom(input,source){
  const target=resolve(input),info=await fs.lstat(target),room=await fs.realpath(target);
  if(!info.isDirectory()||!privateOwner(info)||within(source,room)||
    !/^mvw-trust-release-[A-Za-z0-9]+$/.test(basename(room)))throw new Error('Unsafe saved release directory.');
  return room;
}
async function releaseLease(room,fresh){
  const path=join(room,lockName);
  if(fresh)await (await fs.open(path,'wx',0o600)).close();
  await privateFile(path);
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(path);
  try{db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');}
  catch(error){db.close();throw error;}
  // Separate file so the lease never locks the workbench data, and the OS
  // releases it on process termination without stale PID cleanup.
  return ()=>{try{db.exec('ROLLBACK');}finally{db.close();}};
}
async function readProfile(room){
  const path=join(room,profileName),info=await privateFile(path);
  if(info.size>512)throw new Error('Invalid saved fixture profile.');
  const handle=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const stat=await handle.stat();
    if(stat.ino!==info.ino||stat.dev!==info.dev||stat.nlink!==1||!privateOwner(stat)||stat.size>512)
      throw new Error('Unsafe fixture profile.');
    const bytes=Buffer.alloc(513),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead>512)throw new Error('Invalid saved fixture profile.');
    const parsed=JSON.parse(bytes.subarray(0,bytesRead));
    if(!parsed||typeof parsed!=='object'||Object.keys(parsed).length!==3||parsed.schemaVersion!==1||
      parsed.mode!=='local-synthetic-release'||typeof parsed.seed!=='string'||parsed.seed.length!==64||!/^[0-9a-f]+$/.test(parsed.seed))
      throw new Error('Unrecognized saved fixture profile.');
    return parsed.seed;
  }finally{await handle.close();}
}
async function checkSavedState(room,sqliteFile,seed){
  for(const directory of [join(room,'workspaces'),...regions.map(x=>join(room,'workspaces',x.id))]){
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||!privateOwner(stat))throw new Error('Unsafe saved workspace folder.');
  }
  await privateFile(sqliteFile);
  const db=require('./durable-storage').openSqlite(sqliteFile,{readOnly:true});
  try{
    const expected=new Set(regions.map(x=>'workspace:'+x.id));
    const {mode,documents}=db.snapshot();
    const workbenches=documents.filter(x=>x.kind==='workbench');
    const scopes=new Set(workbenches.map(x=>x.scope));
    const binding=derive(seed,'state-binding','hex');
    if(mode!=='isolated'||scopes.size!==expected.size||documents.some(x=>!expected.has(x.scope))||
      workbenches.some(x=>x.payload.syntheticReleaseBinding!==binding))
      throw new Error('SQLite does not contain this release’s synthetic workspaces.');
  }finally{db.close();}
}
function bindFreshState(sqliteFile,seed){
  const db=require('./durable-storage').openSqlite(sqliteFile);
  try{
    const binding=derive(seed,'state-binding','hex');
    for(const {id} of regions)db.scope('workspace:'+id).write('workbench',(snapshot,save)=>{
      if(!snapshot||snapshot.syntheticReleaseBinding!==undefined)throw new Error('Fresh fixture state was not as expected.');
      save({...snapshot,syntheticReleaseBinding:binding});
    });
  }finally{db.close();}
}
async function close(server){
  if(!server)return;
  await new Promise(resolve=>{
    server.close(()=>resolve());
    server.closeAllConnections();
  });
}
async function launch({port,check,resume}){
  checkRuntime({sqlite:true});
  const source=await fs.realpath(__dirname);
  const parent=resume?null:await fs.realpath(tmpdir());
  if(parent&&within(source,parent))throw new Error('The OS temporary directory must be outside the release source.');
  const room=resume?await savedRoom(resume,source):await fs.mkdtemp(join(parent,'mvw-trust-release-'));
  let server,announced=false,stopping=false,stopped,signal,closing,release,leaseTimer,wroteAccess=false,cleaned=false;
  const accessFile=join(room,'synthetic-access.json');
  const sqliteFile=join(room,'workspace.sqlite');
  const cleanup=async()=>{if(!cleaned){await fs.rm(room,{recursive:true,force:true,maxRetries:2});cleaned=true;}};
  const drain=()=>closing??=close(server);
  try{
    if(!resume&&process.platform!=='win32')await fs.chmod(room,0o700);
    release=await releaseLease(room,!resume);
    const seed=resume?await readProfile(room):randomBytes(32).toString('hex');
    if(resume)await checkSavedState(room,sqliteFile,seed);
    const validUntil=Date.now()+leaseTime,{credentials,isolated}=localFixture(room,seed,validUntil);
    const {createServer}=require('./server');
    server=createServer({dataFile:join(room,'unused-demo.json'),sqliteFile,isolated});
    stopped=new Promise(resolve=>{
      signal=()=>{stopping=true;void drain().then(resolve);};
      process.on('SIGINT',signal);
      process.on('SIGTERM',signal);
      leaseTimer=setTimeout(signal,Math.max(0,validUntil-Date.now()));
      leaseTimer.unref();
    });
    await once(server.listen(port,host),'listening');
    const url=await verified(server,credentials,resume);
    if(stopping)return;
    if(!resume)bindFreshState(sqliteFile,seed);
    if(check){
      await drain();
      release();release=null;
      await cleanup();
      process.stdout.write(JSON.stringify({status:'verified',mode:'local-synthetic',storage:'sqlite',workspaceCount:regions.length})+'\n');
      return;
    }
    if(!resume){
      await fs.writeFile(join(room,profileName),JSON.stringify({schemaVersion:1,mode:'local-synthetic-release',seed})+'\n',
        {flag:'wx',mode:0o600,flush:true});
    }else if(await privateFile(accessFile,{optional:true}))await fs.unlink(accessFile);
    // Take ownership before the write, so a partially created file is removed.
    wroteAccess=true;
    await fs.writeFile(accessFile,JSON.stringify(credentials,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
    if(stopping)return;
    announced=true;
    process.stdout.write(JSON.stringify({status:'ready',mode:'local-synthetic',url,accessFile,runDirectory:room,...(resume?{resumed:true}:{})})+'\n');
    await stopped;
  }finally{
    if(signal){
      process.off('SIGINT',signal);
      process.off('SIGTERM',signal);
      clearTimeout(leaseTimer);
    }
    try{
      if(server)await drain();
      if(wroteAccess)await fs.rm(accessFile,{force:true,maxRetries:2});
    }finally{
      release?.();
      if(!resume&&!announced)await cleanup();
    }
  }
}

async function main(){
  let options;
  try{options=argumentsFor(process.argv.slice(2));}
  catch{process.stderr.write(usage+'\n');process.exitCode=1;return;}
  if(options.help){process.stdout.write(usage+'\n');return;}
  try{await launch(options);}
  catch{process.stderr.write('MVW Trust did not start or stop cleanly. Check Node.js/SQLite, the private OS temp folder, the loopback port, or whether the saved release is invalid or already running.\n');process.exitCode=1;}
}
if(require.main===module)void main();
