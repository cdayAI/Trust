'use strict';

const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const http=require('node:http');
const {tmpdir}=require('node:os');
const {isAbsolute,join,relative,sep}=require('node:path');
const {checkRuntime}=require('./scripts/runtime-check');

const host='127.0.0.1';
const hours=8;
const usage='Usage: node start-release.js [--port 0–65535] [--check]';
const regions=[{id:'harbor',label:'Fictional Harbor'},{id:'orchard',label:'Fictional Orchard'}];

function argumentsFor(args){
  if(args.length===1&&args[0]==='--help')return {help:true};
  let port,check=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--check'&&!check)check=true;
    else if(args[i]==='--port'&&port===undefined){
      const value=args[++i];
      if(typeof value!=='string'||value.trim()!==value||!/^\d{1,5}$/.test(value)||Number(value)>65535)
        throw new Error(usage);
      port=Number(value);
    }else throw new Error(usage);
  }
  return {port:port??0,check};
}
const code=()=>randomBytes(32).toString('base64url');
function localFixture(room){
  const {codeHash}=require('./workspace-access');
  const scopes=regions.map(x=>x.id);
  const validUntil=Date.now()+hours*60*60*1000;
  const staff=[
    ['sample-intake',{harbor:'analyst',orchard:'reviewer'}],
    ['sample-review',{harbor:'reviewer'}],
    ['sample-orchard',{orchard:'analyst'}],
    ['sample-publisher',{harbor:'publisher',orchard:'publisher'}],
    ['sample-case-operator',{harbor:'case-operator',orchard:'case-operator'}],
    ['sample-identity-admin',{harbor:'identity-admin',orchard:'identity-admin'}],
    ['sample-ethics-investigator',{harbor:'ethics-investigator',orchard:'ethics-investigator'}],
    ['sample-ethics-reviewer',{harbor:'ethics-reviewer',orchard:'ethics-reviewer'}],
  ].map(([id,memberships])=>({id,memberships,code:code(),validUntil}));
  const requesters=scopes.map(workspace=>({id:'request-'+workspace,workspace,alias:'sample-reader-'+workspace,
    code:code(),expiresAt:validUntil}));
  const employees=scopes.map(workspace=>({workspace,alias:'sample-staff-'+workspace,code:code(),expiresAt:validUntil}));
  const learners=scopes.map(workspace=>({workspace,alias:'sample-learner-'+workspace,code:code(),expiresAt:validUntil}));
  const hashed=({code,...seat})=>({...seat,codeHash:codeHash(code)});
  return {
    credentials:{schemaVersion:1,mode:'local-synthetic-only',validUntil:new Date(validUntil).toISOString(),
      staff,requesters,employees,learners},
    isolated:{
      root:join(room,'workspaces'),workspaces:regions,enableIdentityAdmin:true,accounts:staff.map(hashed),
      groupApplications:scopes.map(workspace=>({workspace,applications:[
        {id:'sample-case-reference',name:'Fictional Case Reference',summary:'Synthetic group membership and reviewed access exercise.'},
        {id:'sample-service-register',name:'Fictional Service Register',summary:'Fictional local service only. No external systems.'},
      ]})),
      rightsCaseScopeWorkspaces:scopes,documentScopeWorkspaces:scopes,attachmentReviewWorkspaces:scopes,largePdfAttachmentWorkspaces:scopes,
      trustCenters:scopes.map(workspace=>({workspace,slug:'sample-'+workspace})),
      requesterGrants:requesters.map(hashed),employeeGrants:employees.map(hashed),trainingGrants:learners.map(hashed),
      employeeSigningKey:randomBytes(32).toString('hex'),trainingSigningKey:randomBytes(32).toString('hex'),
    },
  };
}
function localRequest(port,path,body,cookie){
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
async function verified(server,credentials){
  const {address,port}=server.address();
  if(address!==host||!port)throw new Error('Local listener was not on loopback.');
  const live=await localRequest(port,'/health/live');
  const ready=await localRequest(port,'/health/ready');
  const anonymous=await localRequest(port,'/api/session');
  if(live.status!==200||live.data.status!=='live'||ready.status!==200||ready.data.status!=='ready'||
    ready.data.checks?.configuration!==true||ready.data.checks?.storage!==true||
    anonymous.status!==200||anonymous.data.authenticated!==false||anonymous.data.mode!=='local-isolated')
    throw new Error('The isolated SQLite workbench did not pass local readiness.');
  for(const [id,workspace] of [['sample-intake','harbor'],['sample-orchard','orchard']]){
    const {code}=credentials.staff.find(seat=>seat.id===id);
    const [other]=regions.map(x=>x.id).filter(x=>x!==workspace);
    const login=await localRequest(port,'/api/session/login',{account:id,code,workspace});
    if(login.status!==200||login.data.workspace!==workspace||login.data.actor!=='analyst'||
      !login.cookie?.startsWith('trust_local_session='))throw new Error('A synthetic login probe failed.');
    const allowed=await localRequest(port,'/api/state?workspace='+workspace,undefined,login.cookie);
    const denied=await localRequest(port,'/api/state?workspace='+other,undefined,login.cookie);
    const signout=await localRequest(port,'/api/session/logout',{},login.cookie);
    if(allowed.status!==200||!Array.isArray(allowed.data.projects)||allowed.data.projects.length||
      denied.status!==403||signout.status!==200)throw new Error('A synthetic workspace boundary probe failed.');
  }
  return 'http://'+host+':'+port;
}
function within(root,filepath){
  const difference=relative(root,filepath);
  return difference===''||(!isAbsolute(difference)&&difference!=='..'&&!difference.startsWith('..'+sep));
}
async function close(server){
  if(!server)return;
  await new Promise(resolve=>{
    server.close(()=>resolve());
    server.closeAllConnections();
  });
}
async function launch({port,check}){
  checkRuntime({sqlite:true});
  const parent=await fs.realpath(tmpdir());
  const source=await fs.realpath(__dirname);
  if(within(source,parent))throw new Error('The OS temporary directory must be outside the release source.');
  const room=await fs.mkdtemp(join(parent,'mvw-trust-release-'));
  let server,announced=false,stopping=false,stopped,signal,closing;
  const accessFile=join(room,'synthetic-access.json');
  const sqliteFile=join(room,'workspace.sqlite');
  const cleanup=()=>fs.rm(room,{recursive:true,force:true,maxRetries:2});
  const drain=()=>closing??=close(server);
  try{
    if(process.platform!=='win32')await fs.chmod(room,0o700);
    const {credentials,isolated}=localFixture(room);
    const {createServer}=require('./server');
    server=createServer({dataFile:join(room,'unused-demo.json'),sqliteFile,isolated});
    // Register cleanup before starting so a stop during readiness can't publish codes.
    stopped=new Promise(resolve=>{
      signal=()=>{stopping=true;void drain().then(resolve);};
      process.on('SIGINT',signal);
      process.on('SIGTERM',signal);
    });
    await once(server.listen(port,host),'listening');
    const url=await verified(server,credentials);
    if(stopping)return;
    if(check){
      await drain();
      await cleanup();
      process.stdout.write(JSON.stringify({status:'verified',mode:'local-synthetic',storage:'sqlite',workspaceCount:regions.length})+'\n');
      return;
    }
    await fs.writeFile(accessFile,JSON.stringify(credentials,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
    if(stopping)return;
    announced=true;
    process.stdout.write(JSON.stringify({status:'ready',mode:'local-synthetic',url,accessFile,runDirectory:room})+'\n');
    await stopped;
  }finally{
    if(signal){
      process.off('SIGINT',signal);
      process.off('SIGTERM',signal);
    }
    if(server)await drain();
    if(announced)await fs.rm(accessFile,{force:true,maxRetries:2});
    else await cleanup();
  }
}

async function main(){
  let options;
  try{options=argumentsFor(process.argv.slice(2));}
  catch{process.stderr.write(usage+'\n');process.exitCode=1;return;}
  if(options.help){process.stdout.write(usage+'\n');return;}
  try{await launch(options);}
  catch{process.stderr.write('MVW Trust did not start or stop cleanly. Check Node.js/SQLite, the private OS temp folder and the loopback port.\n');process.exitCode=1;}
}
if(require.main===module)void main();
