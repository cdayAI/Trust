'use strict';

const applicationId=0x4d565754;
const schemaVersion=1;
const selected=process.env.TRUST_SQLITE_DRIVER??'node';
if(!['node','rust'].includes(selected))throw Error('Unsupported TRUST_SQLITE_DRIVER; expected node or rust.');
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

function nodeDriver(filename,readOnly){
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(filename,{readOnly});
  const statements=new Map();
  const statement=sql=>{
    if(!statements.has(sql))statements.set(sql,db.prepare(sql));
    return statements.get(sql);
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
    supportsSchema:()=>db.prepare('PRAGMA application_id').get().application_id===applicationId&&
      db.prepare('PRAGMA user_version').get().user_version===schemaVersion,
    readMode:()=>statement('SELECT mode FROM storage_mode WHERE singleton = 1').get()?.mode,
    setMode:mode=>statement('INSERT INTO storage_mode (singleton, mode) VALUES (1, ?)').run(mode),
    read:(scope,kind)=>statement('SELECT payload, generation FROM snapshots WHERE scope = ? AND kind = ?').get(scope,kind),
    readSince:(scope,kind,generation)=>statement('SELECT generation, CASE WHEN generation <> ? THEN payload ELSE NULL END AS payload FROM snapshots WHERE scope = ? AND kind = ?').get(generation,scope,kind),
    save(scope,kind,payload){
      const result=statement(`INSERT INTO snapshots (scope, kind, generation, payload) VALUES (?, ?, 1, ?)
        ON CONFLICT (scope, kind) DO UPDATE SET generation = generation + 1, payload = excluded.payload
        WHERE generation < ${maxGeneration}`).run(scope,kind,payload);
      if(Number(result.changes)!==1)throw Error('SQLite snapshot generation exceeds the supported safe integer range.');
    },
    integrity(){
      const rows=db.prepare('PRAGMA integrity_check').all();
      return rows.length===1&&rows[0].integrity_check==='ok';
    },
    documents:()=>statement('SELECT scope, kind, generation, payload FROM snapshots ORDER BY scope, kind').all(),
    hasSnapshots:()=>!!statement('SELECT 1 FROM snapshots LIMIT 1').get(),
    insert:(scope,kind,generation,payload)=>statement('INSERT INTO snapshots (scope, kind, generation, payload) VALUES (?, ?, ?, ?)').run(scope,kind,generation,payload),
    close(){statements.clear();db.close();}
  };
}

let binding;
function rustDriver(filename,readOnly){
  const fs=require('node:fs'),path=require('node:path');
  if(!binding){
    const artifact=path.join(__dirname,'native-storage','target','release-artifact','trust_storage.node');
    let stat;
    try{stat=fs.lstatSync(artifact);}catch(error){
      if(error.code==='ENOENT')throw Error('Rust SQLite driver is required but not built; run npm run build:rust-sqlite.');
      throw error;
    }
    if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>64*1024*1024)throw Error('Invalid Rust SQLite driver artifact.');
    const native=require(artifact);
    if(native.storageAbi?.()!==1||typeof native.NativeStorage!=='function'||!/^3\.[0-9]+\.[0-9]+$/.test(native.sqliteVersion?.()??''))throw Error('Incompatible Rust SQLite driver ABI.');
    binding=native;
  }
  const driver=new binding.NativeStorage(filename,readOnly);
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
    integrity:()=>driver.integrity(),
    documents:()=>driver.documents(),
    hasSnapshots:()=>driver.hasSnapshots(),
    insert:(scope,kind,generation,payload)=>driver.insert(scope,kind,generation,payload),
    close:()=>driver.close()
  };
}
function createStorageDriver(filename,readOnly){return selected==='rust'?rustDriver(filename,readOnly):nodeDriver(filename,readOnly);}
function selectedStorageDriver(){return selected;}
module.exports={createStorageDriver,selectedStorageDriver};
