'use strict';

const waitMs=60_000;
interface WorkerProvision {isolated?:{workspaces?:unknown};corporate?:unknown;sqliteFile?:unknown}
type Timer=ReturnType<typeof setTimeout>|number;
interface WorkerOptions {wake:(now:number)=>unknown;onError?:(error:unknown)=>void;clock?:()=>number;schedule?:(callback:()=>void,ms:number)=>Timer;cancel?:(timer:Timer)=>void}
function provision(workspace:unknown,{isolated,corporate,sqliteFile}:WorkerProvision):string|null{
  if(workspace===undefined)return null;
  if(typeof workspace!=='string'||!sqliteFile||corporate!==undefined||
    !Array.isArray(isolated?.workspaces)||!isolated.workspaces.some((space:unknown)=>space!==null&&typeof space==='object'&&'id' in space&&space.id===workspace))
    throw Error('The report worker requires one named local synthetic workspace and SQLite; it is unavailable with corporate sign-in.');
  return workspace;
}

// Local timer only. No network client, HTTP worker route, destination, lockfile,
// secondary datastore, or async self-overlap. The named SQLite transaction
// owns scheduling state and at most one due capture per callback.
function createWorker({wake,onError=()=>{},clock=Date.now,schedule=setTimeout,cancel=clearTimeout}:WorkerOptions){
  let running=false,pending:Timer|undefined;
  function enqueue(){
    pending=schedule(()=>{
      pending=undefined;
      if(!running)return;
      try{wake(clock());}
      catch(error){onError(error);}
      finally{if(running)enqueue();}
    },waitMs);
    if(typeof pending==='object')pending.unref?.();
  }
  return {
    start(){if(!running){running=true;enqueue();}},
    stop(){running=false;if(pending!==undefined)cancel(pending);pending=undefined;}
  };
}
export = {provision,createWorker};
