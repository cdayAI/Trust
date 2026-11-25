'use strict';

const waitMs=60_000;
function provision(workspace,{isolated,corporate,sqliteFile}){
  if(workspace===undefined)return null;
  if(typeof workspace!=='string'||!sqliteFile||corporate!==undefined||
    !Array.isArray(isolated?.workspaces)||!isolated.workspaces.some(space=>space.id===workspace))
    throw Error('The report worker requires one named local synthetic workspace and SQLite; it is unavailable with corporate sign-in.');
  return workspace;
}

// Local timer only. No network client, HTTP worker route, destination, lockfile,
// secondary datastore, or async self-overlap. The named SQLite transaction
// owns scheduling state and at most one due capture per callback.
function createWorker({wake,onError=()=>{},clock=Date.now,schedule=setTimeout,cancel=clearTimeout}){
  let running=false,pending;
  function enqueue(){
    pending=schedule(()=>{
      pending=undefined;
      if(!running)return;
      try{wake(clock());}
      catch(error){onError(error);}
      finally{if(running)enqueue();}
    },waitMs);
    pending?.unref?.();
  }
  return {
    start(){if(!running){running=true;enqueue();}},
    stop(){running=false;if(pending!==undefined)cancel(pending);pending=undefined;}
  };
}
module.exports={provision,createWorker};
