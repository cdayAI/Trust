'use strict';
// Cache only committed JSON snapshots. Reads always check the current SQLite
// generation; writes never use the cache. A generation is scoped to one store.
interface Versioned<T> {generation:number;payload?:T}
interface Reader<T> {readSince(kind:'workbench',knownGeneration:number):Versioned<T>}
const immutableSnapshots=new WeakSet<object>();
function freezeJson<T extends object>(snapshot:T):T{
  const pending:object[]=[snapshot];
  const seen=new WeakSet<object>();
  while(pending.length){
    const item=pending.pop()!;
    if(seen.has(item))continue;
    seen.add(item);
    for(const value of Object.values(item) as unknown[])
      if(value!==null&&typeof value==='object')pending.push(value);
    Object.freeze(item);
  }
  immutableSnapshots.add(snapshot);
  return snapshot;
}
function isCachedSnapshot(value:unknown):boolean{
  return value!==null&&typeof value==='object'&&immutableSnapshots.has(value);
}
function createSnapshotReader<T extends object>(storage:Reader<T>,fresh:()=>T){
  let known=-1,payload:T|undefined;
  function reset():void{known=-1;payload=undefined;}
  function read():{generation:number;payload:T}{
    try{
      const next=storage.readSince('workbench',known);
      if(!Number.isSafeInteger(next.generation)||next.generation<0)throw Error('Invalid committed snapshot generation.');
      if(next.generation===0){
        // Do not memoize a synthetic, absent database row.
        known=0;payload=undefined;
        return {generation:0,payload:fresh()};
      }
      if(next.generation!==known){
        if(!next.payload)throw Error('Changed SQLite snapshot has no payload.');
        payload=freezeJson(next.payload);
        known=next.generation;
      }
      if(!payload)throw Error('Missing committed snapshot.');
      return {generation:known,payload};
    }catch(error){reset();throw error;}
  }
  return Object.freeze({read,reset});
}
export = {createSnapshotReader,isCachedSnapshot};
