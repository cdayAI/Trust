//! Native implementation of the fixed Trust SQLite snapshot schema.
//! No caller-supplied SQL, connection escape hatch or extension loading.
use napi::{Error, Result};
use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{path::Path, time::Duration};

const APPLICATION_ID: i64 = 0x4d565754;
const MAX_GENERATION: i64 = 9_007_199_254_740_991;
const SCHEMA: &str = r#"
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
PRAGMA application_id = 1297504084;
PRAGMA user_version = 1;
"#;

fn err(message: &str) -> Error { Error::from_reason(message) }
fn sqlite_err(error: rusqlite::Error) -> Error {
    if let rusqlite::Error::SqliteFailure(code, _) = &error {
        if matches!(code.extended_code & 0xff, 5 | 6) { return err("TRUST_SQLITE_BUSY"); }
    }
    err("SQLite database operation failed.")
}
fn generation(value: i64) -> Result<f64> {
    if !(1..=MAX_GENERATION).contains(&value) {
        return Err(err("SQLite snapshot generation exceeds the supported safe integer range."));
    }
    Ok(value as f64)
}
fn input_generation(value: f64, known: bool) -> Result<i64> {
    if !value.is_finite() || value.fract()!=0.0 || value < (if known {-1.0} else {1.0})
        || value > MAX_GENERATION as f64 {
        return Err(err("Invalid storage document generation."));
    }
    Ok(value as i64)
}
fn key(scope: &str, kind: &str) -> Result<()> {
    let valid = scope == "demo" || scope.strip_prefix("workspace:").is_some_and(|slug| {
        let b=slug.as_bytes();
        (1..=48).contains(&b.len()) && b[0].is_ascii_lowercase() &&
          b.iter().all(|v|v.is_ascii_lowercase()||v.is_ascii_digit()||*v==b'-')
    });
    if !valid || !matches!(kind,"workbench"|"workflow") { return Err(err("Invalid storage document.")); }
    Ok(())
}

#[napi(object)]
pub struct ReadRow { pub generation: f64, pub payload: Option<String> }
#[napi(object)]
pub struct DocumentRow { pub scope:String, pub kind:String, pub generation:f64, pub payload:String }
#[napi(js_name="storageAbi")]
pub fn storage_abi()->u32 {1}
#[napi(js_name="sqliteVersion")]
pub fn sqlite_version()->String {rusqlite::version().to_owned()}

#[napi]
pub struct NativeStorage { conn:Option<Connection>, read_only:bool, writing:bool }
impl NativeStorage {
    fn db(&self)->Result<&Connection>{self.conn.as_ref().ok_or_else(||err("SQLite storage is closed."))}
    fn writer(&self)->Result<&Connection>{
        let conn=self.db()?;
        if self.read_only||!self.writing||conn.is_autocommit(){return Err(err("Storage document is not writable outside a write transaction."));}
        Ok(conn)
    }
}
#[napi]
impl NativeStorage {
    #[napi(constructor)]
    pub fn new(filename:String,read_only:bool)->Result<Self>{
        if !Path::new(&filename).is_absolute(){return Err(err("Provide an absolute on-disk SQLite pathname."));}
        // The host owns file creation and identity verification; never create or interpret URI names here.
        let flags=if read_only {OpenFlags::SQLITE_OPEN_READ_ONLY}else{OpenFlags::SQLITE_OPEN_READ_WRITE};
        let conn=Connection::open_with_flags(filename,flags|OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(sqlite_err)?;
        Ok(Self{conn:Some(conn),read_only,writing:false})
    }
    #[napi]
    pub fn configure(&self)->Result<()>{
        let conn=self.db()?;
        conn.busy_timeout(Duration::from_millis(5000)).map_err(sqlite_err)?;
        conn.execute_batch("PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;").map_err(sqlite_err)?;
        if !self.read_only{conn.execute_batch("PRAGMA synchronous = FULL;").map_err(sqlite_err)?;}
        Ok(())
    }
    #[napi]
    pub fn begin(&mut self,write:bool)->Result<()>{
        let conn=self.db()?;
        if !conn.is_autocommit()||(write&&self.read_only){return Err(err("Invalid SQLite transaction."));}
        conn.execute_batch(if write{"BEGIN IMMEDIATE"}else{"BEGIN"}).map_err(sqlite_err)?;
        self.writing=write;Ok(())
    }
    #[napi]
    pub fn commit(&mut self)->Result<()>{
        self.db()?.execute_batch("COMMIT").map_err(sqlite_err)?;self.writing=false;Ok(())
    }
    #[napi]
    pub fn rollback(&mut self)->Result<()>{
        let conn=self.db()?;
        if !conn.is_autocommit(){conn.execute_batch("ROLLBACK").map_err(sqlite_err)?;}
        self.writing=false;Ok(())
    }
    #[napi]
    pub fn initialize(&self)->Result<()>{self.writer()?.execute_batch(SCHEMA).map_err(sqlite_err)}
    #[napi(js_name="supportsSchema")]
    pub fn supports_schema(&self)->Result<bool>{
        let c=self.db()?;
        let app:i64=c.query_row("PRAGMA application_id",[],|r|r.get(0)).map_err(sqlite_err)?;
        let version:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(sqlite_err)?;
        Ok(app==APPLICATION_ID&&version==1)
    }
    #[napi(js_name="readMode")]
    pub fn read_mode(&self)->Result<Option<String>>{
        self.db()?.prepare_cached("SELECT mode FROM storage_mode WHERE singleton=1").map_err(sqlite_err)?
          .query_row([],|r|r.get(0)).optional().map_err(sqlite_err)
    }
    #[napi(js_name="setMode")]
    pub fn set_mode(&self,mode:String)->Result<()>{
        if !matches!(mode.as_str(),"demo"|"isolated"){return Err(err("Invalid writable workbench mode."));}
        self.writer()?.prepare_cached("INSERT INTO storage_mode (singleton,mode) VALUES (1,?)")
          .map_err(sqlite_err)?.execute(params![mode]).map_err(sqlite_err)?;Ok(())
    }
    #[napi]
    pub fn read(&self,scope:String,kind:String)->Result<Option<ReadRow>>{
        key(&scope,&kind)?;
        let row:Option<(i64,String)>=self.db()?.prepare_cached("SELECT generation,payload FROM snapshots WHERE scope=? AND kind=?")
          .map_err(sqlite_err)?.query_row(params![scope,kind],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sqlite_err)?;
        row.map(|(v,p)|Ok(ReadRow{generation:generation(v)?,payload:Some(p)})).transpose()
    }
    #[napi(js_name="readSince")]
    pub fn read_since(&self,scope:String,kind:String,known:f64)->Result<Option<ReadRow>>{
        key(&scope,&kind)?;let known=input_generation(known,true)?;
        let row:Option<(i64,Option<String>)>=self.db()?.prepare_cached("SELECT generation,CASE WHEN generation<>? THEN payload ELSE NULL END FROM snapshots WHERE scope=? AND kind=?")
          .map_err(sqlite_err)?.query_row(params![known,scope,kind],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sqlite_err)?;
        row.map(|(v,p)|Ok(ReadRow{generation:generation(v)?,payload:p})).transpose()
    }
    #[napi]
    pub fn save(&self,scope:String,kind:String,payload:String)->Result<()>{
        key(&scope,&kind)?;
        let n=self.writer()?.prepare_cached("INSERT INTO snapshots (scope,kind,generation,payload) VALUES (?,?,1,?) ON CONFLICT (scope,kind) DO UPDATE SET generation=generation+1,payload=excluded.payload WHERE generation<9007199254740991")
          .map_err(sqlite_err)?.execute(params![scope,kind,payload]).map_err(sqlite_err)?;
        if n!=1{return Err(err("SQLite snapshot generation exceeds the supported safe integer range."));}Ok(())
    }
    #[napi]
    pub fn integrity(&self)->Result<bool>{
        let mut stmt=self.db()?.prepare("PRAGMA integrity_check").map_err(sqlite_err)?;
        let mut rows=stmt.query([]).map_err(sqlite_err)?;
        let Some(row)=rows.next().map_err(sqlite_err)? else{return Ok(false)};
        let value:String=row.get(0).map_err(sqlite_err)?;
        Ok(value=="ok"&&rows.next().map_err(sqlite_err)?.is_none())
    }
    #[napi]
    pub fn documents(&self)->Result<Vec<DocumentRow>>{
        let mut stmt=self.db()?.prepare_cached("SELECT scope,kind,generation,payload FROM snapshots ORDER BY scope,kind").map_err(sqlite_err)?;
        let mut rows=stmt.query([]).map_err(sqlite_err)?;
        let mut out=Vec::new();
        while let Some(r)=rows.next().map_err(sqlite_err)?{
            out.push(DocumentRow{scope:r.get(0).map_err(sqlite_err)?,kind:r.get(1).map_err(sqlite_err)?,
              generation:generation(r.get::<_,i64>(2).map_err(sqlite_err)?)?,payload:r.get(3).map_err(sqlite_err)?});
        }Ok(out)
    }
    #[napi(js_name="hasSnapshots")]
    pub fn has_snapshots(&self)->Result<bool>{
        let n:Option<i64>=self.db()?.prepare_cached("SELECT 1 FROM snapshots LIMIT 1").map_err(sqlite_err)?
          .query_row([],|r|r.get(0)).optional().map_err(sqlite_err)?;Ok(n.is_some())
    }
    #[napi]
    pub fn insert(&self,scope:String,kind:String,generation:f64,payload:String)->Result<()>{
        key(&scope,&kind)?;let generation=input_generation(generation,false)?;
        self.writer()?.prepare_cached("INSERT INTO snapshots (scope,kind,generation,payload) VALUES (?,?,?,?)")
          .map_err(sqlite_err)?.execute(params![scope,kind,generation,payload]).map_err(sqlite_err)?;Ok(())
    }
    #[napi]
    pub fn close(&mut self)->Result<()>{
        let conn=self.conn.take().ok_or_else(||err("SQLite storage is closed."))?;
        conn.flush_prepared_statement_cache();
        match conn.close(){Ok(())=>{self.writing=false;Ok(())},Err((c,e))=>{self.conn=Some(c);Err(sqlite_err(e))}}
    }
}
