'use strict';
const immutableSnapshots=new WeakSet();
function freezeJson(snapshot){
  const pending=[snapshot],seen=new WeakSet();
  while(pending.length){
    const item=pending.pop();if(seen.has(item))continue;seen.add(item);
    for(const value of Object.values(item))if(value!==null&&typeof value==='object')pending.push(value);
    Object.freeze(item);
  }
  immutableSnapshots.add(snapshot);return snapshot;
}
function isCachedSnapshot(value){return value!==null&&typeof value==='object'&&immutableSnapshots.has(value);}
function createSnapshotReader(storage,fresh){
  let known=-1,payload;
  function reset(){known=-1;payload=undefined;}
  function read(){
    try{
      const next=storage.readSince('workbench',known);
      if(!Number.isSafeInteger(next.generation)||next.generation<0)throw Error('Invalid committed snapshot generation.');
      if(next.generation===0){known=0;payload=undefined;return {generation:0,payload:fresh()};}
      if(next.generation!==known){if(!next.payload)throw Error('Changed SQLite snapshot has no payload.');payload=freezeJson(next.payload);known=next.generation;}
      if(!payload)throw Error('Missing committed snapshot.');
      return {generation:known,payload};
    }catch(error){reset();throw error;}
  }
  return Object.freeze({read,reset});
}
module.exports={createSnapshotReader,isCachedSnapshot};
