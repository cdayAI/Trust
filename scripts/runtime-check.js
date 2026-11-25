'use strict';

const required = [22, 13, 0];

function checkRuntime({ sqlite = false, version = process.versions.node } = {}) {
  const bits = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version)?.slice(1).map(Number);
  const firstDifference = bits?.findIndex((value, i) => value !== required[i]);
  if (!bits || (firstDifference !== -1 && bits[firstDifference] < required[firstDifference])) {
    throw new Error('Node.js 22.13.0 or newer is required. Found ' + version + '.');
  }
  if (typeof fetch !== 'function' || typeof structuredClone !== 'function' || typeof AbortSignal.timeout !== 'function') {
    throw new Error('This Node.js build is missing a required web API.');
  }
  const report = { node: version, platform: process.platform, architecture: process.arch };
  if (sqlite) {
    let db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(':memory:');
      db.exec('BEGIN IMMEDIATE; CREATE TABLE runtime_check (n INTEGER); INSERT INTO runtime_check VALUES (1); COMMIT;');
      if (db.prepare('SELECT n FROM runtime_check').get().n !== 1) throw new Error('SQLite test transaction failed.');
      report.sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
    } catch (error) {
      throw new Error('This Node.js installation cannot run SQLite mode: ' + error.message);
    } finally { db?.close(); }
  }
  return report;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--sqlite')) {
      throw new Error('Usage: node scripts/runtime-check.js [--sqlite]');
    }
    console.log(JSON.stringify(checkRuntime({ sqlite: args.includes('--sqlite') })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { checkRuntime };
