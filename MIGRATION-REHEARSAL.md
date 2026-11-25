# Rehearse a fictional migration locally

This is an offline receiving-environment rehearsal. It accepts only the original fictional transfer format, not third-party platform exports, actual work data, network endpoints, documents, accounts, identities, free text, or credentials. It does not implement a proprietary mapping, import approval history, or establish readiness for production.

## Plan, review, import

Use a private local test directory. Run the commands from the source directory with the Node.js runtime listed in [local distribution](LOCAL-RELEASE.md).

```sh
npm run storage -- plan-fixture-import fixtures/fictional-transfer-v1.json migration-rehearsal /private/test/plan.json
# Inspect stages, duplicate counts, mappings, deferred bindings, and planDigest.
npm run storage -- import-fixture fixtures/fictional-transfer-v1.json /private/test/plan.json /private/test/imported.sqlite --confirm PLAN_DIGEST
```

Use actual new paths in place of the example. Substitute the exact digest from the reviewed dry run for `PLAN_DIGEST`. Planning creates only an owner-only review file, never a database. Import independently transforms the bounded source again and refuses any changes to the approved plan or normalized input. Source record order and insignificant JSON whitespace do not affect the digest; adding a duplicate or changing its content does. Local SHA-256 digests bind content and scope, not a human's identity and not an external signature. Keep the plan private.

The source is strict UTF-8 JSON (at most 512 KiB) with only the sections and fields shown in the [bundled example](fixtures/fictional-transfer-v1.json). Use package identifiers `fixture-NNNN` (four digits), node/link/term keys `nNNNN`, `lNNNN`, `tNNNN`, and a workspace beginning with `migration-`. Caps are 100 inventory rows, 250 relationship rows, 40 dictionary rows, and 100 binding rows, counting duplicates. At least one inventory item is required. Owner enum: `studio`, `operations`, `quality`. Per-node profiles: systems `archive|service`; datasets `signals|events`; activities `quality|rehearsal`. Relationship and term kinds use the current application rules.

The dry run reports four stages: inventory nodes, graph edges, dictionary drafts, and deferred term bindings. Exact duplicates collapse; edge aliases collapse to the same semantic ID; conflicting keys, dangling references, incompatible relationships or bindings, and directed cycles abort the whole rehearsal. Package identity, type and key (or the semantic edge triple) produce stable target IDs. Synthetic graph records use a fixed fixture date; the durable audit event and receipt record the actual import time. Terms are new drafts and bindings are never applied by this tool. In an authorized local workspace, submit and review terms independently, then attach the approved versions through the standard dictionary flow using the dry-run IDs.

Import builds and verifies the isolated SQLite snapshot off to the side, then atomically publishes it on the destination filesystem, never overwriting an existing file. The receipt appears on stdout and is stored in the SQLite backup scope, but not published in the app's broad state API. Its counts do not imply that deferred work was applied.

To open the result, use the loopback local isolation runtime with the new database as `sqliteFile` and a fresh empty workspace root. Provision the exact dry-run workspace ID with test-only analyst/reviewer accounts. The normal demo launcher uses different default workspace IDs, so use a custom receiving test config. [The integration test](test/fixture-migration.test.js) shows the exact `createServer` configuration and verifies the authenticated map/dictionary readback, draft approval, and workspace isolation. Do not point the receiving configuration at an existing database or official environment.

## Rollback rehearsal

The source contains no previous production state. The pre-import state is empty. Explicit rollback produces a separate empty isolated database; it does **not** delete or modify the import.

```sh
npm run storage -- rollback-fixture-import /private/test/imported.sqlite /private/test/rollback.sqlite --confirm RECEIPT_ID
```

Supply the exact `receiptId` printed by import. Rollback requires a pristine, dedicated imported snapshot with no other workspaces or workflow writes. It refuses drift rather than silently dropping test work, and refuses any existing output. Use the resulting database instead of the imported one to complete rollback. See [storage and recovery](DURABLE-STORAGE.md) for ordinary backups and verified restores. Keep access configuration, test credentials, plans, backups, and databases out of source control.
