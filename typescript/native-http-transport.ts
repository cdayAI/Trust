'use strict';
// Native transport, with a private, nonce-authenticated Unix
// socket to the existing application handler. Never binds a public interface.
import {spawn} from 'node:child_process';
import type {ChildProcessByStdio} from 'node:child_process';
import type {Readable,Writable} from 'node:stream';
import type {Server,AddressInfo} from 'node:net';
import {lstatSync} from 'node:fs';
import fs = require('node:fs/promises');
import {join} from 'node:path';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import contract = require('./native-http-abi');
const descriptor=contract.descriptor(__dirname);
type Exit={code:number|null;signal:NodeJS.Signals|null};
function missing(error:unknown):boolean{return error instanceof Error&&'code' in error&&error.code==='ENOENT';}
const choice=process.env.TRUST_HTTP_TRANSPORT;
if(choice!==undefined&&!['node','rust'].includes(choice))throw Error('Unsupported TRUST_HTTP_TRANSPORT; expected node or rust.');
if(descriptor&&choice==='node')throw Error('A native HTTP release cannot disable its Rust listener.');
const selected=descriptor?'rust':choice??'node';
if(descriptor)contract.bytesFor(__dirname,descriptor);
function requested(){return selected==='rust';}
function provision(room:string){
  if(!requested())return null;
  if(process.platform!=='linux')throw Error('Native HTTP transport is currently qualified only on Linux.');
  const uid=process.getuid?.();
  if(uid===undefined)throw Error('Native HTTP transport requires a local user ID.');
  const executable=descriptor?join(room,'http-listener'):join(__dirname,contract.built);
  if(!descriptor){
    const stat=lstatSync(executable);
    if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>32*1024*1024||(stat.mode&0o022))
      throw Error('Invalid native HTTP executable.');
  }
  const socket=join(room,'http.sock');
  if(Buffer.byteLength(socket)>100)throw Error('Private HTTP socket path is too long.');
  const token=randomBytes(32).toString('hex');
  let endpoint:AddressInfo|undefined,child:ChildProcessByStdio<Writable,Readable,null>|undefined,exited:Promise<Exit>|undefined,stopping=false,stopped:Promise<void>|undefined,staged=false;
  async function listen(server:Server,port:number):Promise<void>{
    if(descriptor){
      let old;
      try{old=await fs.lstat(executable);}catch(error){if(!missing(error))throw error;}
      if(old){
        if(!old.isFile()||old.nlink!==1||old.uid!==uid||(old.mode&0o077))
          throw Error('Unsafe stale native HTTP executable.');
        await fs.unlink(executable);
      }
      const bytes=contract.bytesFor(__dirname,descriptor);
      const file=await fs.open(executable,'wx',0o700);
      staged=true;
      try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    }
    let previous;
    try{previous=await fs.lstat(socket);}catch(error){if(!missing(error))throw error;}
    if(previous){
      // Called only after obtaining the private release lease.
      if(!previous.isSocket()||previous.uid!==uid)throw Error('Unsafe stale private HTTP socket.');
      await fs.unlink(socket);
    }
    await once(server.listen(socket),'listening');
    await fs.chmod(socket,0o600);
    const proc=spawn(executable,[socket,String(port)],{stdio:['pipe','pipe','ignore'],windowsHide:true,
      env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
    child=proc;
    proc.stdin.on('error',()=>{});
    exited=new Promise<Exit>(resolve=>{
      proc.once('error',()=>resolve({code:null,signal:null}));
      proc.once('close',(code,signal)=>resolve({code,signal}));
    });
    proc.stdin.write(token+'\n');
    let output='',timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const bound=await Promise.race([
        new Promise<number>((resolve,reject)=>{
          proc.stdout.setEncoding('utf8').on('data',chunk=>{
            output+=chunk;
            if(output.length>32){reject(Error('Invalid native HTTP listener output.'));return;}
            if(output.includes('\n')){
              const m=/^([1-9][0-9]{0,4})\n$/.exec(output);
              if(!m||Number(m[1])>65535||port&&Number(m[1])!==port){reject(Error('Invalid native HTTP listener port.'));return;}
              resolve(Number(m[1]));
            }
          });
          timer=setTimeout(()=>reject(Error('Native HTTP startup deadline.')),10000);
        }),
        exited.then(()=>{throw Error('Native HTTP listener exited during startup.');})
      ]);
      endpoint={address:'127.0.0.1',port:bound,family:'IPv4'};
    }catch(error){await stop();throw error;}finally{clearTimeout(timer);}
  }
  function stop():Promise<void>{
    if(stopped)return stopped;
    stopping=true;
    stopped=(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const proc=child;
        if(proc){
          proc.stdin.end();
          await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{proc.kill('SIGKILL');resolve();},2000);})]);
          await exited;
        }
      }finally{clearTimeout(timer);if(staged)await fs.rm(executable,{force:true});}
    })();
    return stopped;
  }
  return Object.freeze({token,address:()=>endpoint,listen,stop,unexpectedExit(callback:()=>void){
    if(!exited)throw Error('Native HTTP listener not started.');
    void exited.then(()=>{if(!stopping)callback();});
  }});
}
export = {requested,provision};
