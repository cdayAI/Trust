'use strict';

const { backupDatabase, verifyBackup, restoreDatabase, migrateDemo, migrateIsolated } = require('./durable-storage');
const [command, ...args] = process.argv.slice(2);
const usage = `Usage:
  npm run storage -- backup DATABASE NEW_BACKUP
  npm run storage -- verify BACKUP
  npm run storage -- restore BACKUP NEW_DATABASE
  npm run storage -- migrate STATE_JSON NEW_DATABASE [WORKFLOW_JSON]
  npm run storage -- migrate-isolated WORKSPACES_ROOT NEW_DATABASE`;

try {
  let result;
  if (command === 'backup' && args.length === 2) result = backupDatabase(...args);
  else if (command === 'verify' && args.length === 1) {
    const value = verifyBackup(args[0]);
    result = { mode: value.mode, documents: value.documents.length, sha256: value.sha256 };
  } else if (command === 'restore' && args.length === 2) result = restoreDatabase(...args);
  else if (command === 'migrate' && [2, 3].includes(args.length)) result = migrateDemo(...args);
  else if (command === 'migrate-isolated' && args.length === 2) result = migrateIsolated(...args);
  else if (command === '--help' && args.length === 0) console.log(usage);
  else throw new Error(usage);
  if (result) console.log(JSON.stringify(result));
} catch (error) {
  console.error('Storage operation failed: ' + error.message);
  process.exitCode = 1;
}
