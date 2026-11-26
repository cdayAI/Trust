'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {openSqlite}=require('../durable-storage');
const {selectedStorageDriver}=require('../storage-driver');
const workflow=label=>({schemaVersion:1,definitions:[{id:label}],instances:[],events:[]});
test('explicit driver selection rejects unsupported values',()=>{
  const result=spawnSync(process.execPath,['-e',"require('./storage-driver').selectedStorageDriver()"],{
    cwd:resolve(__dirname,'..'),env:{...process.env,TRUST_SQLITE_DRIVER:'invalid'},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/driver/i);
});
test('selected driver preserves rollback, scoped generations and interoperable SQLite files',async()=>{
  assert.equal(selectedStorageDriver(),process.env.TRUST_SQLITE_DRIVER||'node');
  const dir=await mkdtemp(join(tmpdir(),'trust-native-driver-')),file=join(dir,'store.sqlite');
  let db,other,reopened;
  try{
    db=openSqlite(file);db.requireMode('isolated');
    const alpha=db.scope('workspace:alpha'),beta=db.scope('workspace:beta');
    alpha.write('workflow',(_previous,save)=>save(workflow('one')));
    assert.deepEqual(alpha.read('workflow'),workflow('one'));
    assert.equal(db.snapshot().documents[0].generation,1);
    assert.throws(()=>alpha.write('workflow',(_previous,save)=>{save(workflow('discard'));throw Error('rollback');}),/rollback/);
    assert.deepEqual(alpha.read('workflow'),workflow('one'));
    other=new DatabaseSync(file);
    assert.equal(other.prepare('PRAGMA application_id').get().application_id,0x4d565754);
    assert.equal(other.prepare('PRAGMA user_version').get().user_version,1);
    assert.equal(other.prepare('SELECT generation FROM snapshots WHERE scope=? AND kind=?').get('workspace:alpha','workflow').generation,1);
    beta.write('workflow',(_previous,save)=>save(workflow('beta')));
    assert.deepEqual(alpha.read('workflow'),workflow('one'));
    assert.deepEqual(beta.read('workflow'),workflow('beta'));
    other.prepare('UPDATE snapshots SET generation=? WHERE scope=? AND kind=?').run(Number.MAX_SAFE_INTEGER,'workspace:alpha','workflow');
    assert.throws(()=>alpha.write('workflow',(_previous,save)=>save(workflow('overflow'))),/generation|range|integer/i);
    assert.deepEqual(alpha.read('workflow'),workflow('one'));
    other.close();other=null;db.close();db=null;
    reopened=openSqlite(file,{readOnly:true});
    assert.deepEqual(reopened.scope('workspace:beta').read('workflow'),workflow('beta'));
    assert.equal(reopened.snapshot().documents.length,2);
  }finally{if(reopened)reopened.close();if(other)other.close();if(db)db.close();await rm(dir,{recursive:true,force:true});}
});
