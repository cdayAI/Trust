'use strict';
import type {RustCore,BackupEnvelope} from './contracts';
import fs = require('node:fs');
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import durable = require('./durable-storage');
const rust:RustCore=require('./rust-core');
const {captureBackup,verifyBackupContent,publishNew,restoreDocuments,maxFileBytes}=durable;

const magic = Buffer.from('MVWTRSTE', 'ascii');
const version = 1, cipherId = 1;
const algorithm = 'aes-256-gcm';
const nonceBytes = 12, tagBytes = 16, keyBytes = 32;
const nonceOffset = magic.length + 2;
const lengthOffset = nonceOffset + nonceBytes;
const headerBytes = lengthOffset + 4;
const overhead = headerBytes + tagBytes;
const blockBytes = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fsFlags = fs.constants;
const invalidArchive = 'Invalid or unsupported encrypted backup envelope.';
const keyFailure = 'Provide a private, owner-only, single-link key file containing exactly 32 raw bytes (mode 0400 or 0600).';
const archiveFailure = 'Expected a single-link encrypted backup file within the local size limit.';

function stable(a:fs.BigIntStats, b:fs.BigIntStats):boolean {
  return (['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'] as const).every(field => a[field] === b[field]);
}
function openBounded(file:string, valid:(info:fs.BigIntStats)=>boolean, failure:string):{fd:number;info:fs.BigIntStats} {
  let fd:number|undefined;
  try {
    const expected = fs.lstatSync(file, { bigint: true });
    if (!expected.isFile() || expected.nlink !== 1n || !valid(expected)) throw Error(failure);
    fd = fs.openSync(file, fsFlags.O_RDONLY | fsFlags.O_NOFOLLOW | fsFlags.O_NONBLOCK);
    const actual = fs.fstatSync(fd, { bigint: true });
    if (!actual.isFile() || !stable(expected, actual) || !valid(actual)) throw Error(failure);
    return { fd, info: actual };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw Error(failure);
  }
}
function readExact(fd:number, buffer:Buffer, start:number, failure:string):void {
  for (let off = 0; off < buffer.length;) {
    const count = fs.readSync(fd, buffer, off, buffer.length - off, start + off);
    if (!count) throw Error(failure);
    off += count;
  }
}
function writeExact(fd:number, buffer:Buffer):void {
  for (let off = 0; off < buffer.length;) {
    const count = fs.writeSync(fd, buffer, off, buffer.length - off, null);
    if (!count) throw Error('Writing the encrypted backup did not complete.');
    off += count;
  }
}
function readKey(file:string):Buffer {
  // Do not pretend POSIX mode bits are Windows ACLs.
  if (typeof process.geteuid !== 'function' || !Number.isSafeInteger(fsFlags.O_NOFOLLOW) ||
      !Number.isSafeInteger(fsFlags.O_NONBLOCK))
    throw Error('Encrypted backup keys require POSIX file ownership and permission checks.');
  const euid = BigInt(process.geteuid());
  const valid = (info:fs.BigIntStats) => info.uid === euid && info.size === BigInt(keyBytes) &&
    [0o400n, 0o600n].includes(info.mode & 0o7777n);
  const { fd, info } = openBounded(file, valid, keyFailure);
  const key = Buffer.alloc(keyBytes);
  try {
    readExact(fd, key, 0, keyFailure);
    if (!stable(info, fs.fstatSync(fd, { bigint: true }))) throw Error(keyFailure);
    return key;
  } catch {
    key.fill(0);
    throw Error(keyFailure);
  } finally {
    fs.closeSync(fd);
  }
}
function withKey<T>(file:string, operation:(key:Buffer)=>T):T {
  const key = readKey(file);
  try { return operation(key); }
  finally { key.fill(0); }
}
function makeHeader(size:number):Buffer {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxFileBytes)
    throw Error('Backup exceeds the 128 MiB local limit.');
  const header = Buffer.alloc(headerBytes);
  magic.copy(header);
  header[magic.length] = version;
  header[magic.length + 1] = cipherId;
  randomBytes(nonceBytes).copy(header, nonceOffset);
  header.writeUInt32BE(size, lengthOffset);
  return header;
}
function expectedSize(header:Buffer, archiveSize:number):number {
  if (rust.enabled) {
    const size=rust.encryptedSize(header,archiveSize);
    if(size<1)throw Error(invalidArchive);
    return size;
  }
  if (!header.subarray(0, magic.length).equals(magic) ||
    header[magic.length] !== version || header[magic.length + 1] !== cipherId) throw Error(invalidArchive);
  const size = header.readUInt32BE(lengthOffset);
  if (!size || size > maxFileBytes || archiveSize !== overhead + size) throw Error(invalidArchive);
  return size;
}
function writeEncrypted(file:string, plain:Buffer, key:Buffer):void {
  const header = makeHeader(plain.length);
  const cipher = createCipheriv(algorithm, key, header.subarray(nonceOffset, lengthOffset), { authTagLength: tagBytes });
  cipher.setAAD(header, { plaintextLength: plain.length });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    writeExact(fd, header);
    for (let at = 0; at < plain.length; at += blockBytes) {
      writeExact(fd, cipher.update(plain.subarray(at, Math.min(plain.length, at + blockBytes))));
    }
    writeExact(fd, cipher.final());
    writeExact(fd, cipher.getAuthTag());
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function readEncrypted(file:string, key:Buffer):BackupEnvelope {
  const { fd, info } = openBounded(file, info => info.size >= BigInt(overhead + 1) &&
    info.size <= BigInt(overhead + maxFileBytes), archiveFailure);
  const header = Buffer.alloc(headerBytes), tag = Buffer.alloc(tagBytes);
  let plain:Buffer|undefined;
  try {
    readExact(fd, header, 0, invalidArchive);
    const size = expectedSize(header, Number(info.size));
    readExact(fd, tag, headerBytes + size, invalidArchive);
    const decipher = createDecipheriv(algorithm, key, header.subarray(nonceOffset, lengthOffset), { authTagLength: tagBytes });
    decipher.setAAD(header, { plaintextLength: size });
    decipher.setAuthTag(tag);
    plain = Buffer.alloc(size);
    const block = Buffer.alloc(Math.min(size, blockBytes));
    let written = 0;
    for (let at = 0; at < size; at += block.length) {
      const chunk = block.subarray(0, Math.min(block.length, size - at));
      readExact(fd, chunk, headerBytes + at, invalidArchive);
      const decrypted = decipher.update(chunk);
      try {
        if (decrypted.length !== chunk.length) throw Error(invalidArchive);
        written += decrypted.copy(plain, written);
      }
      finally { decrypted.fill(0); }
    }
    let tail:Buffer|undefined;
    try {
      tail = decipher.final();
      written += tail.copy(plain, written);
    } catch {
      throw Error('Encrypted backup authentication failed.');
    } finally { tail?.fill(0); }
    if (written !== size || !stable(info, fs.fstatSync(fd, { bigint: true }))) throw Error(invalidArchive);
    let content:unknown;
    // No JSON parsing or restore work before GCM authentication completes.
    try { content = JSON.parse(utf8.decode(plain)); }
    catch { throw Error('Authenticated backup does not contain valid UTF-8 JSON.'); }
    return verifyBackupContent(content);
  } finally {
    plain?.fill(0);
    fs.closeSync(fd);
  }
}
function summary(value:BackupEnvelope) {
  return { mode: value.mode, documents: value.documents.length, encryption: algorithm, version };
}
function backupEncrypted(source:string, destination:string, keyFile:string) {
  return withKey(keyFile, key => {
    const value = captureBackup(source);
    const json = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(json) > maxFileBytes) throw Error('Backup exceeds the 128 MiB local limit.');
    const plain = Buffer.from(json, 'utf8');
    try { publishNew(destination, temp => {
      writeEncrypted(temp, plain, key);
      const reopened = readEncrypted(temp, key);
      if (reopened.sha256 !== value.sha256) throw Error('Encrypted backup failed verification.');
    }); }
    finally { plain.fill(0); }
    return summary(value);
  });
}
function verifyEncrypted(source:string, keyFile:string) {
  return withKey(keyFile, key => summary(readEncrypted(source, key)));
}
function restoreEncrypted(source:string, destination:string, keyFile:string) {
  return withKey(keyFile, key => {
    const value = readEncrypted(source, key);
    restoreDocuments(value.mode, value.documents, destination);
    return summary(value);
  });
}

export = { backupEncrypted, verifyEncrypted, restoreEncrypted };
