'use strict';
const rust=require('./rust-core');
const {createStorageDriver}=require('./storage-driver');

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { verifyEvidenceSnapshot } = require('./governance-documents');

const backupVersion = 1;
const maxFileBytes = 128 * 1024 * 1024;
const kinds = new Set(['workbench', 'workflow']);
const workspaceId = /^[a-z][a-z0-9-]{0,47}$/;
const scopePattern = /^workspace:[a-z][a-z0-9-]{0,47}$/;
const format = 'mvw-trust-local-backup';
const modes = new Set(['demo', 'isolated']);
const modeFor = scope => scope === 'demo' ? 'demo' : 'isolated';
const basic = data => data && typeof data === 'object' && !Array.isArray(data);
const positive = value => rust.enabled ? rust.storageGeneration(value) : Number.isSafeInteger(value) && value > 0;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const parseJsonBytes = bytes => JSON.parse(utf8.decode(bytes));

function validateScope(scope) {
  if (rust.enabled ? rust.storageScope(scope)===0 : scope !== 'demo' && (typeof scope !== 'string' || !scopePattern.test(scope))) {
    throw new Error('Invalid storage scope.');
  }
  return scope;
}

function validatePayload(kind, payload) {
  if (!kinds.has(kind) || !basic(payload)) throw new Error('Invalid storage document.');
  const valid = rust.enabled ? rust.storagePayload(kind,payload) : (() => {
    const shape = kind === 'workbench'
      ? [payload.version, ['actors', 'projects', 'vendors', 'assessments', 'handoff', 'audit']]
      : [payload.schemaVersion, ['definitions', 'instances', 'events']];
    return shape[0] === 1 && shape[1].every(key => Array.isArray(payload[key]));
  })();
  if (!valid) {
    throw new Error('Unsupported or invalid '+kind+' snapshot.');
  }
  return payload;
}

function readRegularBytes(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxFileBytes) {
    throw new Error('Expected a single-link regular file no larger than 128 MiB.');
  }
  return fs.readFileSync(file);
}

function parseFile(file) {
  return parseJsonBytes(readRegularBytes(file));
}

function preparePath(file) {
  if (typeof file !== 'string' || !file.trim() || file === ':memory:') {
    throw new Error('Provide an on-disk SQLite pathname.');
  }
  return path.resolve(file);
}

function hasLegacySnapshot(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sqliteFileInfo(file) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (process.platform !== 'win32' && (stat.mode & 0o077n))) {
      throw new Error('SQLite storage must be a single-link regular file with owner-only permissions (0600).');
    }
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function rollbackBusy(error) {
  // SQLite's primary BUSY/LOCKED result codes can be carried in an extended code.
  if (error.message === 'TRUST_SQLITE_BUSY' || (error.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 0xff))) {
    return Object.assign(new Error('Storage is busy. Retry shortly.'), { status: 503 });
  }
  return error;
}

function openSqlite(file, { readOnly = false } = {}) {
  const filename = preparePath(file);
  let original = sqliteFileInfo(filename);
  if (!original) {
    if (readOnly) throw new Error('SQLite storage does not exist.');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    original = sqliteFileInfo(filename);
    if (!original) throw new Error('SQLite storage path disappeared during initialization.');
  }
  const db = createStorageDriver(filename, readOnly);
  const inTransaction = (start, callback) => {
    try {
      db.begin(start === 'BEGIN IMMEDIATE');
      try {
        const result = callback();
        if (result && typeof result.then === 'function') throw new TypeError('Storage transactions must be synchronous.');
        db.commit();
        return result;
      } catch (error) {
        try { db.rollback(); } catch {}
        throw error;
      }
    } catch (error) {
      throw rollbackBusy(error);
    }
  };

  try {
    db.configure();
    if (!readOnly && original.size === 0n) {
      // Another opener may finish initialization while this handle waits.
      // An interrupted first launch can also leave the empty owner-only file.
      inTransaction('BEGIN IMMEDIATE', () => {
        if (fs.statSync(filename).size !== 0) return;
        db.initialize();
      });
    }
    if (!db.supportsSchema()) {
      throw new Error('Unrecognized or unsupported MVW Trust SQLite store.');
    }
    const verifyMode = mode => {
      if (!modes.has(mode) || db.readMode() !== mode) {
        throw new Error('SQLite store is not configured for this workbench mode.');
      }
    };
    const decode = (kind, row) => row ? validatePayload(kind, JSON.parse(row.payload)) : undefined;
    return {
      checkMode(mode) {
        // A live handle can still read an unlinked or renamed database.
        const current = sqliteFileInfo(filename);
        if (!current || current.dev !== original.dev || current.ino !== original.ino) {
          throw new Error('SQLite storage path changed while the database was open.');
        }
        verifyMode(mode);
      },
      requireMode(mode) {
        if (!modes.has(mode) || readOnly) throw new Error('Invalid writable workbench mode.');
        return inTransaction('BEGIN IMMEDIATE', () => {
          const current = db.readMode();
          if (current === undefined) db.setMode(mode);
          else verifyMode(mode);
        });
      },
      scope(scope) {
        const mode = modeFor(validateScope(scope));
        verifyMode(mode);
        return {
          read(kind) {
            if (!kinds.has(kind)) throw new Error('Invalid storage document kind.');
            try { return decode(kind, db.read(scope, kind)); }
            catch (error) { throw rollbackBusy(error); }
          },
          // Read generation and changed payload in a single statement. A reader
          // in another process must always see the last committed generation;
          // never rely on local writes, file timestamps, or a time-to-live.
          readSince(kind, knownGeneration) {
            if (!kinds.has(kind) || !Number.isSafeInteger(knownGeneration) || knownGeneration < -1) {
              throw new Error('Invalid storage document generation.');
            }
            try {
              const row = db.readSince(scope, kind, knownGeneration);
              if (!row) return { generation: 0 };
              return row.generation === knownGeneration ? { generation: row.generation } :
                { generation: row.generation, payload: decode(kind, row) };
            } catch (error) { throw rollbackBusy(error); }
          },
          write(kind, callback) {
            if (readOnly || !kinds.has(kind)) throw new Error('Storage document is not writable.');
            return inTransaction('BEGIN IMMEDIATE', () => {
              let active = true, saved = false;
              try {
                const row=db.read(scope,kind), previous=decode(kind,row);
                const save=payload=>{
                  if (!active) throw new Error('Storage transaction is closed.');
                  db.save(scope,kind,JSON.stringify(validatePayload(kind,payload)));
                  saved=true;
                };
                // Only the staff-intake operation can use this fixed append.
                // Keep the existing full-write path for absent rows and any
                // shape that is not a simple, exact append.
                const appendIntake=(next,caseRow,auditRow)=>{
                  if(!active)throw Error('Storage transaction is closed.');
                  if(saved||kind!=='workbench'||!row||!previous||!basic(next)||!basic(caseRow)||!basic(auditRow))return false;
                  const before=previous.rightsCases??[],after=next.rightsCases;
                  if(!Array.isArray(before)||!Array.isArray(after)||after.length!==before.length+1||
                    after.at(-1)!==caseRow||before.some((value,index)=>after[index]!==value)||
                    !Array.isArray(next.audit)||next.audit.length!==previous.audit.length+1||
                    next.audit.at(-1)!==auditRow||previous.audit.some((value,index)=>next.audit[index]!==value))return false;
                  const otherKeys=value=>Object.keys(value).filter(key=>key!=='rightsCases'&&key!=='audit');
                  const keys=otherKeys(previous);
                  if(otherKeys(next).length!==keys.length||keys.some(key=>!Object.hasOwn(next,key)||next[key]!==previous[key]))return false;
                  if(typeof caseRow.id!=='string'||caseRow.revision!==1||caseRow.status!=='received'||
                    auditRow.action!=='rights.case.opened'||auditRow.entityId!==caseRow.id||
                    !Number.isSafeInteger(auditRow.sequence)||auditRow.sequence!==(previous.audit.at(-1)?.sequence??0)+1)return false;
                  validatePayload(kind,next);
                  saved=db.appendIntake(scope,row.generation,JSON.stringify(caseRow),JSON.stringify(auditRow));
                  return saved;
                };
                return callback(previous,save,row?.generation??0,appendIntake);
              } finally { active = false; }
            });
          },
        };
      },
      snapshot() {
        return inTransaction('BEGIN', () => {
          if (!db.integrity()) {
            throw new Error('SQLite integrity check failed.');
          }
          const mode = db.readMode();
          const documents = db.documents()
            .map(row => ({ scope: validateScope(row.scope), kind: row.kind, generation: row.generation, payload: decode(row.kind, row) }));
          validateDocuments(mode, documents);
          verifyEvidenceDocuments(documents);
          return { mode, documents };
        });
      },
      import(mode, documents) {
        if (readOnly) throw new Error('Storage is read-only.');
        verifyMode(mode);
        validateDocuments(mode, documents);
        verifyEvidenceDocuments(documents);
        return inTransaction('BEGIN IMMEDIATE', () => {
          if (db.hasSnapshots()) throw new Error('Restore target is not empty.');
          for (const d of documents) db.insert(d.scope, d.kind, d.generation, JSON.stringify(d.payload));
        });
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function validateDocuments(mode, documents) {
  if (!modes.has(mode) || !Array.isArray(documents)) throw new Error('Invalid backup documents.');
  const seen = new Set();
  for (const d of documents) {
    if (!basic(d) || Object.keys(d).length !== 4 || !positive(d.generation)) {
      throw new Error('Invalid backup document metadata.');
    }
    const key = validateScope(d.scope) + '/' + d.kind;
    if (modeFor(d.scope) !== mode) throw new Error('Backup document scope does not match storage mode.');
    if (seen.has(key)) throw new Error('Duplicate backup document.');
    seen.add(key);
    validatePayload(d.kind, d.payload);
  }
  return documents;
}

function verifyEvidenceDocuments(documents) {
  for (const { kind, payload } of documents) if (kind === 'workbench') verifyEvidenceSnapshot(payload);
}

function envelope(mode, documents) {
  validateDocuments(mode, documents);
  const content = { format, version: backupVersion, mode, documents };
  return { ...content, sha256: hash(JSON.stringify(content)) };
}

function verifyBackupContent(content) {
  if (!basic(content) || Object.keys(content).length !== 5 || content.format !== format ||
      content.version !== backupVersion || typeof content.sha256 !== 'string') {
    throw new Error('Unknown or unsupported backup format.');
  }
  const unsigned = envelope(content.mode, content.documents);
  if (unsigned.sha256 !== content.sha256) throw new Error('Backup checksum mismatch.');
  verifyEvidenceDocuments(unsigned.documents);
  return unsigned;
}

function verifyBackup(file) {
  return verifyBackupContent(parseFile(file));
}

// Prepare and verify on the target filesystem, then publish with an atomic no-clobber
// link. Do not rename over a target that may have appeared between checks.
function publishNew(file, build) {
  const output = preparePath(file);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(output), '.trust-storage-' + randomUUID() + '.tmp');
  try {
    build(temp);
    fs.linkSync(temp, output);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(output), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

function captureBackup(source) {
  const db = openSqlite(source, { readOnly: true });
  let value;
  try { const {mode,documents}=db.snapshot(); value = envelope(mode,documents); } finally { db.close(); }
  return value;
}

function backupDatabase(source, destination) {
  const value = captureBackup(source);
  const json = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(json) > maxFileBytes) throw new Error('Backup exceeds the 128 MiB local limit.');
  publishNew(destination, temp => {
    fs.writeFileSync(temp, json, { flag: 'wx', mode: 0o600, flush: true });
    verifyBackup(temp);
  });
  return { mode:value.mode, documents: value.documents.length, sha256: value.sha256 };
}

function restoreDocuments(mode, documents, destination) {
  validateDocuments(mode, documents);
  verifyEvidenceDocuments(documents);
  publishNew(destination, temp => {
    const db = openSqlite(temp);
    try {
      db.requireMode(mode);
      db.import(mode, documents);
      const reopened=db.snapshot();
      const actual = envelope(reopened.mode,reopened.documents);
      const sorted = documents.slice().sort((a, b) =>
        a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
      if (actual.sha256 !== envelope(mode,sorted).sha256) throw new Error('Restored snapshot failed verification.');
    } finally { db.close(); }
  });
  return { mode, documents: documents.length };
}

function restoreDatabase(source, destination) {
  const {mode,documents}=verifyBackup(source);
  return restoreDocuments(mode,documents,destination);
}

function legacyDocument(file, scope, kind, optional = false) {
  try { return { scope, kind, generation: 1, payload: validatePayload(kind, parseFile(file)) }; }
  catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
}

function migrateDemo(stateFile, dbFile, workflowFile) {
  const workbench = legacyDocument(stateFile, 'demo', 'workbench');
  const workflow = legacyDocument(workflowFile ?? (stateFile + '.workflows'), 'demo', 'workflow', workflowFile === undefined);
  return restoreDocuments('demo',[workbench, workflow].filter(Boolean), dbFile);
}

function migrateIsolated(root, dbFile) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Expected a real isolated legacy root directory.');
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.some(entry => !entry.isDirectory() || !workspaceId.test(entry.name))) {
    throw new Error('Isolated root must contain only valid workspace directories.');
  }
  const documents = entries.flatMap(entry => {
    const dir = path.join(root, entry.name);
    const scope = 'workspace:' + entry.name;
    const files = fs.readdirSync(dir);
    if (files.some(file => !['state.json', 'workflows.json'].includes(file))) {
      throw new Error('Workspace directory contains unexpected files; inspect it before migration.');
    }
    return [
      legacyDocument(path.join(dir, 'state.json'), scope, 'workbench', true),
      legacyDocument(path.join(dir, 'workflows.json'), scope, 'workflow', true),
    ].filter(Boolean);
  });
  return restoreDocuments('isolated',documents, dbFile);
}

module.exports = { openSqlite, backupDatabase, verifyBackup, restoreDatabase, migrateDemo, migrateIsolated, hasLegacySnapshot, publishNew, restoreDocuments, captureBackup, verifyBackupContent, maxFileBytes, parseJsonBytes };
