'use strict';

const { backupDatabase, verifyBackup, restoreDatabase, migrateDemo, migrateIsolated } = require('./durable-storage');
const { backupEncrypted, verifyEncrypted, restoreEncrypted } = require('./storage-encryption');
const {writePlan,diagnoseFixture,importFixture,verifyFixture,rollbackFixture}=require('./fixture-migration');
const [command, ...args] = process.argv.slice(2);
const usage = `Usage:
  npm run storage -- backup DATABASE NEW_BACKUP
  npm run storage -- verify BACKUP
  npm run storage -- restore BACKUP NEW_DATABASE
  npm run storage -- backup-encrypted DATABASE NEW_ARCHIVE PRIVATE_KEY_FILE
  npm run storage -- verify-encrypted ARCHIVE PRIVATE_KEY_FILE
  npm run storage -- restore-encrypted ARCHIVE NEW_DATABASE PRIVATE_KEY_FILE
  npm run storage -- migrate STATE_JSON NEW_DATABASE [WORKFLOW_JSON]
  npm run storage -- migrate-isolated WORKSPACES_ROOT NEW_DATABASE
  npm run storage -- diagnose-fixture-import FICTIONAL_PACKAGE_JSON migration-WORKSPACE
  npm run storage -- plan-fixture-import FICTIONAL_PACKAGE_JSON migration-WORKSPACE NEW_PLAN_JSON
  npm run storage -- import-fixture FICTIONAL_PACKAGE_JSON REVIEWED_PLAN_JSON NEW_DATABASE --confirm PLAN_DIGEST
  npm run storage -- verify-fixture-import FICTIONAL_PACKAGE_JSON REVIEWED_PLAN_JSON IMPORTED_DATABASE --confirm RECEIPT_ID
  npm run storage -- rollback-fixture-import IMPORTED_DATABASE NEW_ROLLBACK_DATABASE --confirm RECEIPT_ID`;

try {
  let result;
  if (command === 'backup' && args.length === 2) result = backupDatabase(...args);
  else if (command === 'verify' && args.length === 1) {
    const value = verifyBackup(args[0]);
    result = { mode: value.mode, documents: value.documents.length, sha256: value.sha256 };
  } else if (command === 'restore' && args.length === 2) result = restoreDatabase(...args);
  else if (command === 'backup-encrypted' && args.length === 3) result = backupEncrypted(...args);
  else if (command === 'verify-encrypted' && args.length === 2) result = verifyEncrypted(...args);
  else if (command === 'restore-encrypted' && args.length === 3) result = restoreEncrypted(...args);
  else if (command === 'migrate' && [2, 3].includes(args.length)) result = migrateDemo(...args);
  else if (command === 'migrate-isolated' && args.length === 2) result = migrateIsolated(...args);
  else if (command === 'diagnose-fixture-import' && args.length === 2) result = diagnoseFixture(...args);
  else if (command === 'plan-fixture-import' && args.length === 3) result = writePlan(...args);
  else if (command === 'import-fixture' && args.length === 5 && args[3] === '--confirm') result = importFixture(...args.slice(0,3),args[4]);
  else if (command === 'verify-fixture-import' && args.length === 5 && args[3] === '--confirm') result = verifyFixture(...args.slice(0,3),args[4]);
  else if (command === 'rollback-fixture-import' && args.length === 4 && args[2] === '--confirm') result = rollbackFixture(...args.slice(0,2),args[3]);
  else if (command === '--help' && args.length === 0) console.log(usage);
  else throw new Error(usage);
  if (result) console.log(JSON.stringify(result));
  if (['blocked','drift'].includes(result?.status))process.exitCode=2;
} catch (error) {
  console.error('Storage operation failed: ' + error.message);
  process.exitCode = 1;
}
