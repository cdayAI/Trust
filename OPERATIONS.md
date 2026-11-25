# MVW Trust local operator runbook

Use a single loopback process with synthetic fixtures. The [enterprise readiness gates](ENTERPRISE-READINESS.md) still apply.

## Release health

1. Run `npm test` with Node.js 22 or newer. For a clean demo launch, use `DATA_FILE="$(mktemp -d)/state.json" npm start`. For workspace isolation, use `npm run start:isolated`. Take the address from the launch output.
2. Call the two probes on that loopback port. They accept GET without a session and return uncached JSON.

   ```sh
   base=http://127.0.0.1:4173
   curl --fail-with-body --max-time 3 -sS "$base/health/live"
   curl --fail-with-body --max-time 3 -sS "$base/health/ready"
   ```

   | Probe | Healthy | Failure |
   | --- | --- | --- |
   | `/health/live` | HTTP 200 and `{"status":"live"}` | Connection error or timeout. Check the launcher and port. |
   | `/health/ready` | HTTP 200, `status: ready`, both checks true | HTTP 503 and `status: not_ready`. A false `configuration` means the listener or main browser assets failed verification. A false `storage` means at least one configured snapshot path or its directory failed verification. |

   Configuration is validated during launch. Readiness checks the bound address and the readability of the HTML, main script, and stylesheet. Storage checks existing snapshot paths for readable regular files, then writes, flushes, renames, reads, and removes a disposable synthetic file in each configured storage directory. An absent snapshot is valid for a fresh workspace. The probe leaves workspace records alone and does not check snapshot contents, restore integrity, or every browser asset.
3. Open the workbench at the same address and load a synthetic workflow. In isolated mode, use the generated access file privately to sign into a synthetic workspace. Pass the local release check after the browser smoke and both probes succeed.

The CLI writes one JSON event per line to stderr. Each has `schemaVersion`, UTC `at`, and a fixed `event`. `listener_started` and `listener_stopped` describe startup and graceful shutdown. Use Ctrl+C to stop a foreground launch. `invalid_port`, `startup_failed`, and `listener_failed` indicate launch failure. The first readiness result and subsequent check changes emit `readiness_passed` or `readiness_failed` with two booleans. Unexpected request failures emit `request_failed` at most once per 30 seconds. Stderr events contain no payloads, routes, paths, credentials, or exception text. Keep isolated launcher stdout private because its human-readable prompts identify where the generated access files are stored.

## Recovery drill

1. Run `node --test test/operational-health.test.js`. The demo drill moves a disposable storage directory aside, checks for live HTTP 200 and ready HTTP 503, restores it, and checks for ready HTTP 200 and unchanged snapshot bytes. The isolated drill verifies that losing one workspace makes the shared listener unready while liveness stays healthy.
2. To rehearse a cold restore, start the demo with a fresh explicit `DATA_FILE` and save a synthetic record. Stop the process, copy the entire demo data directory to a separate backup, then copy the backup to a fresh restore directory. This preserves `state.json` and `state.json.workflows` when present. Set `DATA_FILE` to the restored `state.json` and restart. Confirm both probes, reopen the record, and check the workflow history if present.
3. Use the demo for that persistence rehearsal. `npm run start:isolated` provisions a fresh directory and credentials at every launch. After the drill, stop the process and remove only the disposable files created for it.

## Rollback

If either probe or the browser smoke fails after a candidate change, stop the candidate. From a separate checkout of the last reviewed revision, start with a copy of its matching pre-change synthetic backup. For an isolated launch, provision a fresh synthetic workspace and sign in with that run’s generated codes. Repeat the browser smoke and any probes available in that revision. Preserve the candidate snapshots separately for diagnosis and record the revision and drill results privately.

## Applying the integration patch

`mvw-trust-operations.patch` is based on the reviewed `f2395d2656c0e7846d21dd454ee0c30f6c7ff5b6` server, launcher, and README. In an integration checkout, run `git apply --check /path/to/mvw-trust-operations.patch` before applying it, then run `npm test`. The probes are wired to the JSON snapshot paths selected by `createServer`. If a storage change introduces a new adapter or moves snapshot paths, update that wiring and repeat the outage drill.
