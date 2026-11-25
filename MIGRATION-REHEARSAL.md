# Rehearse a fictional migration locally

This is an offline receiving-environment rehearsal. It accepts only the original fictional transfer format, not third-party platform exports, actual work data, network endpoints, documents, accounts, identities, free text, or credentials. It does not implement a proprietary mapping, import approval history, or establish readiness for production.

## Diagnose, plan, review, import

Use a private local test directory. Run the commands from the source directory with the Node.js runtime listed in [local distribution](LOCAL-RELEASE.md).

```sh
npm run storage -- diagnose-fixture-import fixtures/fictional-transfer-v1.json migration-rehearsal
npm run storage -- plan-fixture-import fixtures/fictional-transfer-v1.json migration-rehearsal /private/test/plan.json
# Inspect stages, duplicate counts, mappings, deferred bindings, and planDigest.
npm run storage -- import-fixture fixtures/fictional-transfer-v1.json /private/test/plan.json /private/test/imported.sqlite --confirm PLAN_DIGEST
```

Diagnostics are optional and read-only. They report stable issue codes, stages and one-based row numbers, not source text. More than one defect may be found, including dependent errors caused by a rejected upstream row. A blocked diagnosis returns exit status 2 with no plan; output begins with the first 50 issues and reports the total.

Use actual new paths in place of the example. Substitute the exact digest from the reviewed dry run for `PLAN_DIGEST`. Planning creates only an owner-only review file, never a database. Import independently transforms the bounded source again and refuses any changes to the approved plan or normalized input. Source record order and insignificant JSON whitespace do not affect the digest; adding a duplicate or changing its content does. Local SHA-256 digests bind content and scope, not a human's identity and not an external signature. Keep the plan private.

The source is strict UTF-8 JSON (at most 512 KiB) with only the sections and fields shown in the [bundled example](fixtures/fictional-transfer-v1.json). Use package identifiers `fixture-NNNN` (four digits), node/link/term keys `nNNNN`, `lNNNN`, `tNNNN`, and a workspace beginning with `migration-`. Caps are 100 inventory rows, 250 relationship rows, 40 dictionary rows, and 100 binding rows, counting duplicates. At least one inventory item is required. Owner enum: `studio`, `operations`, `quality`. Per-node profiles: systems `archive|service`; datasets `signals|events`; activities `quality|rehearsal`. Relationship and term kinds use the current application rules.

The dry run reports four stages: inventory nodes, graph edges, dictionary drafts, and deferred term bindings. Exact duplicates collapse; edge aliases collapse to the same semantic ID; conflicting keys, dangling references, incompatible relationships or bindings, and directed cycles abort the whole rehearsal. Package identity, type and key (or the semantic edge triple) produce stable target IDs. Synthetic graph records use a fixed fixture date; the durable audit event and receipt record the actual import time. Terms are new drafts and bindings are never applied by this tool. In an authorized local workspace, submit and review terms independently, then attach the approved versions through the standard dictionary flow using the dry-run IDs.

Import builds and verifies the isolated SQLite snapshot off to the side, then atomically publishes it on the destination filesystem, never overwriting an existing file. The receipt appears on stdout and is stored in the SQLite backup scope, but not published in the app's broad state API. Its counts do not imply that deferred work was applied.

## Reconcile after import

```sh
npm run storage -- verify-fixture-import fixtures/fictional-transfer-v1.json /private/test/plan.json /private/test/imported.sqlite --confirm RECEIPT_ID
```

Use the receipt ID printed at import time, before the receiver writes anything. Verification rebuilds the expected fixture snapshot from the reviewed inputs and receipt time, opens the database read-only, and verifies the complete supported snapshot and audit against the receipt. The report shows matched, changed, missing, unexpected and duplicate node, edge and term counts and separately checks that deferred term bindings were not activated. It does not echo observed record content. The same verification can be used after a verified backup and restore.

A valid but modified database returns a drift report and exit status 2. It does not fix or remove anything. A broken receipt, wrong workspace or wrong reviewed plan is rejected without reconciliation. Exact verification is for the untouched fixture import, not a certificate for later approved edits or real data.

## Open an editable receiving rehearsal

After the exact import verifies, run:

```sh
npm run start:migration-rehearsal -- fixtures/fictional-transfer-v1.json /private/test/plan.json /private/test/imported.sqlite --confirm RECEIPT_ID
```

With Node only, use `node ./start-migration-rehearsal.js ...` on Linux/macOS or
`node .\start-migration-rehearsal.js ...` in Windows PowerShell. Supply the
same arguments; quote argument paths containing spaces. Append `--port 4173`
to use a particular loopback port, or `--check` to validate actual startup,
sign-in, and imported readback without leaving an editable instance.

The launcher requires the original fixture and reviewed plan, an untouched
dedicated import, and the exact receipt ID. It reads one consistent SQLite
snapshot, verifies it against the reviewed input and receipt, and restores only
that verified snapshot into a fresh private OS temp directory. It does not
modify the original database, plan, or package. An invalid or drifted import
does not open a listener. Workspaces from arbitrary backups, actual work
records, and third-party exports are not accepted.

When ready it prints the local URL and the private access-file path, not the
codes. Open the URL only on the same machine and use the fresh
`rehearsal-analyst` and `rehearsal-reviewer` codes from that file with the
reviewed workspace ID. Do not share the codes, use a shared temp directory,
or enter a work password. Only the disposable copy can be edited, including
independently reviewing a dictionary draft and attaching the approved version.
Nothing is sent outside the machine; no public or corporate listener is
started. The command removes the copy and its codes on graceful Ctrl+C or
after eight hours. A forced kill may leave the temporary directory; remove it
when finished. To start again, launch from the same untouched input. Windows
uses the OS temp directory's inherited permissions; modes are owner-only on
Unix. This is not an actual company's receiving environment.

## Rollback rehearsal

The source contains no previous production state. The pre-import state is empty. Explicit rollback produces a separate empty isolated database; it does **not** delete or modify the import.

```sh
npm run storage -- rollback-fixture-import /private/test/imported.sqlite /private/test/rollback.sqlite --confirm RECEIPT_ID
```

Supply the exact `receiptId` printed by import. Rollback requires a pristine, dedicated imported snapshot with no other workspaces or workflow writes. It refuses drift rather than silently dropping test work, and refuses any existing output. Use the resulting database instead of the imported one to complete rollback. See [storage and recovery](DURABLE-STORAGE.md) for ordinary backups and verified restores. Keep access configuration, test credentials, plans, backups, and databases out of source control.
