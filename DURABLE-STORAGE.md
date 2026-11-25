# Local durable storage and recovery

Use this only for the standalone synthetic application. It is not an enterprise
database deployment, encryption-at-rest implementation, or recovery guarantee.

## Pick a backend

- Without `TRUST_SQLITE_FILE`, the launchers keep the original JSON mode.
- Set `TRUST_SQLITE_FILE` to opt into a transactional SQLite file in either
  launcher. Node 22.13 or later supplies the built-in SQLite driver; the
  implementation was tested on Node 24. The database has a fixed demo or
  isolated mode and cannot silently switch between them. The permission and
  session model stays the same.
- Keep the database and its directory private, and do not put database,
  journal, migration, or backup files into Git. Choose a local regular
  filesystem supporting atomic hard-link creation for recovery outputs.
  The database file is created owner-only; an existing database must be a
  regular, owner-only, single-link file.

```sh
TRUST_SQLITE_FILE="$PWD/data/demo.sqlite" npm start
TRUST_SQLITE_FILE="$PWD/data/isolated.sqlite" npm run start:isolated
```

The current application persists versioned workbench and workflow documents in
one database with a separate row for each scope and document kind. Writes read
the latest snapshot, run synchronously under a SQLite write transaction, and
commit the updated snapshot and its audit events together. Failed commands
roll back unless the application intentionally writes an audit refusal. A
database created for isolated mode keeps tenant documents under a workspace ID
derived from the verified session. An isolated launcher still provisions
synthetic credentials for that process; backups do not copy authentication
configuration, credential files, keys or sessions. Restoring a durable
database does not restore these ephemeral credentials.

SQLite permits one writer at a time. Transaction contention that does not
resolve within five seconds returns a retryable 503. This local backend is not
designed for a shared network filesystem, multi-region writes, or a measured
enterprise load.

## Migrate legacy JSON explicitly

Stop legacy writers before migrating, and retain unchanged source files. The
migration detects recognized versions, imports both document types
transactionally, and verifies the restored snapshot before creating the
destination. It never replaces an existing destination.

```sh
# Defaults to a sibling state.json.workflows if it exists.
npm run storage -- migrate data/state.json data/migrated-demo.sqlite

# Pass the root containing per-workspace state.json/workflows.json, not
# the parent that also contains account or access files.
npm run storage -- migrate-isolated /path/to/workspaces data/migrated-isolated.sqlite
```

If the original isolated mode used different workspace IDs, use the same
trusted workspace configuration when reopening the database. The demo launcher
does not reinterpret isolated state. If a JSON source exists for the selected
scope but its SQLite document is missing, SQLite mode refuses to seed a
replacement. Roll back before cutover by clearing `TRUST_SQLITE_FILE` and
restarting against the unchanged original JSON. That fallback does **not**
include writes accepted after cutover. Take a fresh SQLite backup before
switching back and reconcile those writes separately.

## Backup, verify, restore

```sh
npm run storage -- backup data/demo.sqlite data/demo.trust-backup.json
npm run storage -- verify data/demo.trust-backup.json
npm run storage -- restore data/demo.trust-backup.json data/recovered.sqlite
```

The backup uses a consistent database read transaction, includes both
document types, and records a SHA-256 checksum. Verify the backup before
restoring. Restore to a fresh destination; the command checks the checksum,
known backup version, storage mode, snapshot shape, SQLite integrity, and
restored contents before publishing the new file. It does not replace a
running database or overwrite previous backups. The maximum accepted import
or backup file size is 128 MiB.

Governance evidence is checked before backup, verify, restore, and legacy
JSON migration. The checker validates exact edition identities, text length
and digest, supported typed links to existing records, attachment identity
and byte budgets, recorded sizes and digests, and quarantine state. A valid
draft may retain pending or rejected attachments; a reviewable or published
edition may not. If any evidence check fails, the command leaves the source
unchanged and does not publish a new file. Keep the original and diagnose the
inconsistency rather than recalculating a checksum over broken evidence.

These checks detect inconsistent data. They are not a signed backup, an
authenticity proof against someone who can rewrite both bytes and metadata, a
malware scan, or a replacement for a retention and hold policy. Backups can
retain evidence that was later removed from a live draft.

Checksums catch accidental corruption; they are not authentication or tamper
protection. This format is plaintext, including when the database was running
in isolated mode. Treat it accordingly. The operator still needs approved
encrypted off-host storage, retention, recovery objectives and a scratch
restoration rehearsal before production use.

## Verify

```sh
node --test test/durable-storage.test.js
```

The storage tests cover simultaneous writes from two server processes, scope
isolation after migration and restore, version conflicts, durable refusals,
rollback after a simulated write failure, safe refusal of malformed input,
and byte-for-byte preservation of legacy source files.
