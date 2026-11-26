'use strict';

import type {StorageDriver,StorageSelection,SnapshotKind,SnapshotRow,DocumentRow,StorageMode} from './contracts';
import type {StatementSync} from 'node:sqlite';
import fs = require('node:fs');
import path = require('node:path');
interface NativeStorage extends Omit<StorageDriver,'readMode'|'read'|'readSince'> {
  readMode():string|null|undefined;
  read(scope:string,kind:SnapshotKind):SnapshotRow|null|undefined;
  readSince(scope:string,kind:SnapshotKind,generation:number):SnapshotRow|null|undefined;
}
interface NativeBinding {
  storageAbi():number;
  sqliteVersion():string;
  runtimeProbe():string;
  NativeStorage:new(filename:string,readOnly:boolean)=>NativeStorage;
  NativeLease:new(filename:string)=>{close():void};
}
function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function snapshotRow(value:unknown):SnapshotRow|undefined{
  if(value===undefined||value===null)return undefined;
  if(!record(value)||typeof value.generation!=='number'||!Number.isSafeInteger(value.generation)||value.generation<=0||
    (value.payload!==null&&value.payload!==undefined&&typeof value.payload!=='string'))
    throw Error('Invalid SQLite snapshot row.');
  return {generation:value.generation,payload:value.payload};
}
function documentRow(value:unknown):DocumentRow{
  const row=snapshotRow(value);
  if(!row||!record(value)||typeof value.scope!=='string'||typeof value.kind!=='string'||typeof row.payload!=='string')
    throw Error('Invalid SQLite document row.');
  return {scope:value.scope,kind:value.kind,generation:row.generation,payload:row.payload};
}
function readMode(value:unknown):string|undefined{
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='string')throw Error('Invalid SQLite storage mode.');
  return value;
}
const applicationId=0x4d565754;
const schemaVersion=1;
const nativeContract:typeof import('./native-storage-abi')=require('./native-storage-abi');
const descriptor=nativeContract.descriptor(__dirname);
const requested=process.env.TRUST_SQLITE_DRIVER;
if(requested!==undefined&&requested!=='node'&&requested!=='rust')throw Error('Unsupported TRUST_SQLITE_DRIVER; expected node or rust.');
if(descriptor&&requested==='node')throw Error('A native Rust release cannot disable its Rust SQLite driver.');
const selected:StorageSelection=descriptor?'rust':requested??'node';
// Verify a packaged artifact even when the caller has not opened a database.
if(descriptor)nativeContract.verifyArtifact(__dirname,descriptor);
const schema=`
          CREATE TABLE storage_mode (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            mode TEXT NOT NULL CHECK (mode IN ('demo', 'isolated'))
          ) STRICT;
          CREATE TABLE snapshots (
            scope TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('workbench', 'workflow')),
            generation INTEGER NOT NULL CHECK (generation > 0),
            payload TEXT NOT NULL CHECK (json_valid(payload)),
            PRIMARY KEY (scope, kind)
          ) STRICT, WITHOUT ROWID;
          PRAGMA application_id = ${applicationId};
          PRAGMA user_version = ${schemaVersion};
        `;
const maxGeneration=Number.MAX_SAFE_INTEGER;
// Fixed append-only operation; no caller-supplied SQL or JSON path.
const appendIntakeSql=`UPDATE snapshots
SET generation = generation + 1,
    payload = json_insert(
      CASE WHEN json_type(payload, '$.rightsCases') = 'array' THEN payload
           ELSE json_set(payload, '$.rightsCases', json('[]')) END,
      '$.rightsCases[#]', json(?1),
      '$.audit[#]', json(?2))
WHERE scope = ?3 AND kind = 'workbench' AND generation = ?4
  AND generation < 9007199254740991
  AND json_type(payload, '$.audit') = 'array'
  AND COALESCE(json_type(payload, '$.rightsCases'), 'null') IN ('array', 'null')
  AND json_type(?1) = 'object' AND json_type(?2) = 'object'
  AND json_type(?1, '$.id') = 'text'
  AND json_extract(?1, '$.id') = json_extract(?2, '$.entityId')
  AND json_extract(?2, '$.action') = 'rights.case.opened'
  AND json_extract(?2, '$.sequence') = COALESCE(json_extract(payload, '$.audit[#-1].sequence'), 0) + 1`;

function nodeDriver(filename:string,readOnly:boolean):StorageDriver{
  const {DatabaseSync}:typeof import('node:sqlite')=require('node:sqlite');
  const db=new DatabaseSync(filename,{readOnly});
  const statements=new Map<string,StatementSync>();
  const statement=(sql:string):StatementSync=>{
    let prepared=statements.get(sql);
    if(!prepared){prepared=db.prepare(sql);statements.set(sql,prepared);}
    return prepared;
  };
  return {
    configure(){
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
      if(!readOnly)db.exec('PRAGMA synchronous = FULL;');
    },
    begin:write=>db.exec(write?'BEGIN IMMEDIATE':'BEGIN'),
    commit:()=>db.exec('COMMIT'),
    rollback:()=>db.exec('ROLLBACK'),
    initialize:()=>db.exec(schema),
    supportsSchema:()=>db.prepare('PRAGMA application_id').get()?.application_id===applicationId&&
      db.prepare('PRAGMA user_version').get()?.user_version===schemaVersion,
    readMode:()=>readMode(statement('SELECT mode FROM storage_mode WHERE singleton = 1').get()?.mode),
    setMode:mode=>statement('INSERT INTO storage_mode (singleton, mode) VALUES (1, ?)').run(mode),
    read:(scope,kind)=>snapshotRow(statement('SELECT payload, generation FROM snapshots WHERE scope = ? AND kind = ?').get(scope,kind)),
    readSince:(scope,kind,generation)=>snapshotRow(statement('SELECT generation, CASE WHEN generation <> ? THEN payload ELSE NULL END AS payload FROM snapshots WHERE scope = ? AND kind = ?').get(generation,scope,kind)),
    save(scope,kind,payload){
      const result=statement(`INSERT INTO snapshots (scope, kind, generation, payload) VALUES (?, ?, 1, ?)
        ON CONFLICT (scope, kind) DO UPDATE SET generation = generation + 1, payload = excluded.payload
        WHERE generation < ${maxGeneration}`).run(scope,kind,payload);
      if(Number(result.changes)!==1)throw Error('SQLite snapshot generation exceeds the supported safe integer range.');
    },
    appendIntake(scope,generation,caseJson,eventJson){
      return Number(statement(appendIntakeSql).run(caseJson,eventJson,scope,generation).changes)===1;
    },
    integrity(){
      const rows=db.prepare('PRAGMA integrity_check').all();
      return rows.length===1&&rows[0].integrity_check==='ok';
    },
    documents:()=>statement('SELECT scope, kind, generation, payload FROM snapshots ORDER BY scope, kind').all().map(documentRow),
    hasSnapshots:()=>!!statement('SELECT 1 FROM snapshots LIMIT 1').get(),
    insert:(scope,kind,generation,payload)=>statement('INSERT INTO snapshots (scope, kind, generation, payload) VALUES (?, ?, ?, ?)').run(scope,kind,generation,payload),
    close(){statements.clear();db.close();}
  };
}

let binding:NativeBinding|undefined;
function loadNative():NativeBinding{
  if(!binding){
    const artifact=descriptor?nativeContract.verifyArtifact(__dirname,descriptor):path.join(__dirname,nativeContract.built);
    let stat;
    try{stat=fs.lstatSync(artifact);}catch(error){
      if(error instanceof Error&&'code' in error&&error.code==='ENOENT')throw Error('Rust SQLite driver is required but not built; run npm run build:rust-sqlite.');
      throw error;
    }
    if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>64*1024*1024)throw Error('Invalid Rust SQLite driver artifact.');
    const value:unknown=require(artifact);
    if(!record(value)||typeof value.storageAbi!=='function'||typeof value.sqliteVersion!=='function'||
      typeof value.NativeStorage!=='function'||typeof value.NativeLease!=='function'||typeof value.runtimeProbe!=='function')
      throw Error('Incompatible Rust SQLite driver ABI.');
    const native=value as unknown as NativeBinding;
    if(native.storageAbi()!==nativeContract.abi||!/^3\.[0-9]+\.[0-9]+$/.test(native.sqliteVersion()))
      throw Error('Incompatible Rust SQLite driver ABI.');
    binding=native;
  }
  return binding;
}
function rustDriver(filename:string,readOnly:boolean):StorageDriver{
  const driver=new (loadNative().NativeStorage)(filename,readOnly);
  return {
    configure:()=>driver.configure(),
    begin:write=>driver.begin(write),
    commit:()=>driver.commit(),
    rollback:()=>driver.rollback(),
    initialize:()=>driver.initialize(),
    supportsSchema:()=>driver.supportsSchema(),
    readMode:()=>driver.readMode()??undefined,
    setMode:mode=>driver.setMode(mode),
    read:(scope,kind)=>driver.read(scope,kind)??undefined,
    readSince:(scope,kind,generation)=>driver.readSince(scope,kind,generation)??undefined,
    save:(scope,kind,payload)=>driver.save(scope,kind,payload),
    appendIntake:(scope,generation,caseJson,eventJson)=>driver.appendIntake(scope,generation,caseJson,eventJson),
    integrity:()=>driver.integrity(),
    documents:()=>driver.documents(),
    hasSnapshots:()=>driver.hasSnapshots(),
    insert:(scope,kind,generation,payload)=>driver.insert(scope,kind,generation,payload),
    close:()=>driver.close()
  };
}
function createStorageDriver(filename:string,readOnly:boolean):StorageDriver{return selected==='rust'?rustDriver(filename,readOnly):nodeDriver(filename,readOnly);}
function selectedStorageDriver():StorageSelection{return selected;}
function probeStorageDriver():string{
  if(selected==='rust')return loadNative().runtimeProbe();
  const {DatabaseSync}:typeof import('node:sqlite')=require('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('BEGIN IMMEDIATE; CREATE TABLE runtime_check (n INTEGER); INSERT INTO runtime_check VALUES (1); COMMIT;');
    if(db.prepare('SELECT n FROM runtime_check').get()?.n!==1)throw Error('SQLite test transaction failed.');
    const version=db.prepare('SELECT sqlite_version() AS version').get()?.version;
    if(typeof version!=='string')throw Error('Invalid SQLite version.');
    return version;
  }finally{db.close();}
}
function acquireReleaseLease(filename:string):()=>void{
  if(selected==='rust'){
    const lease=new (loadNative().NativeLease)(filename);
    return ()=>lease.close();
  }
  const {DatabaseSync}:typeof import('node:sqlite')=require('node:sqlite');
  const db=new DatabaseSync(filename);
  try{db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');}
  catch(error){db.close();throw error;}
  return ()=>{try{db.exec('ROLLBACK');}finally{db.close();}};
}
export = {createStorageDriver,selectedStorageDriver,probeStorageDriver,acquireReleaseLease};
