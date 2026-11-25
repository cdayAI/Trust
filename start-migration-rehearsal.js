'use strict';

const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const http=require('node:http');
const {tmpdir}=require('node:os');
const {isAbsolute,join,relative,sep}=require('node:path');
const {checkRuntime}=require('./scripts/runtime-check');

const host='127.0.0.1';
const leaseMs=8*60*60*1000;
const usage='Usage: node start-migration-rehearsal.js FICTIONAL_PACKAGE REVIEWED_PLAN IMPORTED_DATABASE --confirm RECEIPT_ID [--port 0–65535] [--check]';
function parseArgs(args){
  if(args.length===1&&args[0]==='--help')return {help:true};
  const [source,plan,database,flag,receiptId,...options]=args;
  if(![source,plan,database].every(x=>x?.trim()&&!x.startsWith('--'))||flag!=='--confirm'||
    typeof receiptId!=='string'||receiptId.length!==64||!/^[a-f0-9]+$/.test(receiptId))throw Error(usage);
  let port,check=false;
  for(let i=0;i<options.length;i++){
    if(options[i]==='--check'&&!check)check=true;
    else if(options[i]==='--port'&&port===undefined){
      const value=options[++i];
      if(typeof value!=='string'||value.trim()!==value||!/^\d{1,5}$/.test(value)||Number(value)>65535)throw Error(usage);
      port=Number(value);
    }else throw Error(usage);
  }
  return {source,plan,database,receiptId,port:port??0,check};
}
function below(base,target){
  const path=relative(base,target);
  return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep));
}
function localRequest(port,path,body,cookie){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const request=http.request({hostname:host,port,path,agent:false,signal:AbortSignal.timeout(6500),
      method:payload===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),
        ...(payload===undefined?{}:{Origin:'http://'+host+':'+port,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)})}},
    response=>{
      let size=0;
      const chunks=[];
      response.once('error',reject);
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>8*1024*1024){request.destroy(new Error('Local readiness response exceeded its limit.'));return;}
        chunks.push(chunk);
      });
      response.once('end',()=>{
        try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks)),
          cookie:response.headers['set-cookie']?.[0]?.split(';')[0]});}
        catch{reject(new Error('Unexpected local readiness response.'));}
      });
    });
    request.once('error',reject);
    request.end(payload);
  });
}
async function checkListening(server,workspace,staff,proof){
  const {address,port}=server.address();
  if(address!==host||!port)throw Error('Not bound to loopback.');
  const get=(url,cookie)=>localRequest(port,url,undefined,cookie);
  const live=await get('/health/live'),ready=await get('/health/ready'),session=await get('/api/session');
  if(live.status!==200||live.data.status!=='live'||ready.status!==200||ready.data.status!=='ready'||
    ready.data.checks?.configuration!==true||ready.data.checks?.storage!==true||
    session.status!==200||session.data.mode!=='local-isolated'||session.data.authenticated!==false)throw Error('Readiness failed.');
  const scope='?workspace='+encodeURIComponent(workspace),dictionary='/api/dictionary';
  const [analyst]=staff;
  if((await get(dictionary+scope)).status!==401)throw Error('Signed-out gate failed.');
  for(const seat of staff){
    const scopeRole=seat===analyst?'analyst':'reviewer';
    const login=await localRequest(port,'/api/session/login',{account:seat.id,workspace,code:seat.code});
    if(login.status!==200||login.data.workspace!==workspace||login.data.actor!==scopeRole||
      !login.cookie?.startsWith('trust_local_session='))throw Error('Fixture sign-in failed.');
    const read=await get(dictionary+scope,login.cookie);
    if(read.status!==200||read.data.terms?.length!==proof.stages.terms.expected||
      !read.data.terms.every(row=>row.activeVersion===null&&row.versions?.length===1&&row.versions[0].status==='draft'&&row.consumers?.length===0))
      throw Error('Dictionary readback did not match untouched fixture.');
    if(seat===analyst){
      const graph=await get('/api/data-map'+scope,login.cookie);
      if(graph.status!==200||graph.data.nodes?.length!==proof.stages.inventory.expected||
        graph.data.links?.length!==proof.stages.relationships.expected)throw Error('Map readback did not match untouched fixture.');
    }
    const denied=await get(dictionary+'?workspace=unprovisioned-workspace',login.cookie);
    const logout=await localRequest(port,'/api/session/logout',{},login.cookie);
    if(denied.status!==403||logout.status!==200)throw Error('Workspace isolation probe failed.');
  }
  return 'http://'+host+':'+port;
}
function shutdown(server){
  if(!server)return Promise.resolve();
  return new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
}
async function launch(options){
  checkRuntime({sqlite:true});
  const sourceRoot=await fs.realpath(__dirname),parent=await fs.realpath(tmpdir());
  if(below(sourceRoot,parent))throw Error('Use a private OS temp location outside source.');
  const scratch=await fs.mkdtemp(join(parent,'mvw-migration-rehearsal-'));
  let server,closing,stopped,stop,timer,closingRequested=false;
  const close=()=>closing??=shutdown(server);
  try{
    if(process.platform!=='win32')await fs.chmod(scratch,0o700);
    const sqliteFile=join(scratch,'rehearsal.sqlite');
    const {copyVerifiedFixture}=require('./fixture-migration');
    const proof=copyVerifiedFixture(options.source,options.plan,options.database,options.receiptId,sqliteFile);
    const validUntil=Date.now()+leaseMs;
    const staff=['analyst','reviewer'].map(role=>({id:'rehearsal-'+role,memberships:{[proof.workspace]:role},
      code:randomBytes(32).toString('base64url'),validUntil}));
    const {codeHash}=require('./workspace-access');
    const {createServer}=require('./server');
    server=createServer({dataFile:join(scratch,'unused-demo.json'),sqliteFile,isolated:{
      root:join(scratch,'workspaces'),workspaces:[{id:proof.workspace,label:'Fictional receiving rehearsal'}],
      accounts:staff.map(({code,...seat})=>({...seat,codeHash:codeHash(code)})),
    }});
    stopped=new Promise(resolve=>{
      stop=()=>{closingRequested=true;void close().then(resolve);};
      process.on('SIGINT',stop);
      process.on('SIGTERM',stop);
      timer=setTimeout(stop,Math.max(0,validUntil-Date.now()));
      timer.unref();
    });
    await once(server.listen(options.port,host),'listening');
    const url=await checkListening(server,proof.workspace,staff,proof);
    if(closingRequested)return;
    if(options.check){
      await close();
      process.stdout.write(JSON.stringify({status:'verified',mode:'fictional-migration-rehearsal',workspace:proof.workspace,
        sourceRetained:true,editableCopy:false})+'\n');
      return;
    }
    const accessFile=join(scratch,'rehearsal-access.json');
    await fs.writeFile(accessFile,JSON.stringify({version:1,workspace:proof.workspace,mode:'fictional-migration-rehearsal',staff},null,2)+'\n',
      {flag:'wx',mode:0o600,flush:true});
    if(closingRequested)return;
    process.stdout.write(JSON.stringify({status:'ready',mode:'fictional-migration-rehearsal',workspace:proof.workspace,
      sourceRetained:true,editableCopy:true,url,accessFile,runDirectory:scratch})+'\n');
    await stopped;
  }finally{
    if(stop){process.off('SIGINT',stop);process.off('SIGTERM',stop);clearTimeout(timer);}
    try{if(server)await close();}finally{await fs.rm(scratch,{recursive:true,force:true,maxRetries:2});}
  }
}
async function main(){
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch{process.stderr.write(usage+'\n');process.exitCode=1;return;}
  if(options.help){process.stdout.write(usage+'\n');return;}
  try{await launch(options);}
  catch{
    process.stderr.write('Migration rehearsal did not start or stop cleanly. Use an untouched verified fictional import, its reviewed plan and receipt, a private OS temp folder and a free loopback port.\n');
    process.exitCode=1;
  }
}
if(require.main===module)void main();
