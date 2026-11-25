# Staged synthetic discovery rehearsal

This is an opt-in SQLite walkthrough for known local synthetic workspaces.
Launch the isolated workbench with `TRUST_DISCOVERY_REHEARSAL=1` and
`TRUST_SQLITE_FILE`, or explicitly set `isolated.discoveryRunWorkspaces` in a
local synthetic fixture with distinct analyst and reviewer accounts. Ordinary
demo, non-opted workspaces, and corporate sign-in cannot use this mode.

1. The analyst opens **Data mapping**, selects a fixed bundled library
   fixture version, and queues a run. A repeated queue request reopens the
   same source/version run and appends no duplicate audit entry.
2. **Run fixture checks** validates the bundled schema, records metadata
   fingerprints and field counts, and intentionally reports an unavailable
   check on one fixed dataset. This is a scripted demonstration fault, not a
   live failure or arbitrary fault injector. **Resume failed check** completes
   that check only. There is one resume, not an automated retry worker.
3. **Send schema plan for review** stages the exact fixture digest, inventory
   revision, affected records and relationships, and proposed fields. A
   different reviewer opens **Review schema changes** and approves the exact
   plan. Review itself never modifies inventory.
4. The analyst explicitly applies. If there has been a map change, the old
   approval cannot be used. **Reconcile inventory changes** prepares a fresh
   plan for independent review, up to two times. A conflict or exceeded limit
   leaves inventory unchanged. There is no hidden override.
5. Applying v1 then v2 retains the existing record and link IDs, keeps v1
   provenance as history, and adds the v2 field metadata. Execution and the
   resulting summary commit together. No deletion or data value extraction.

In opted-in workspaces the earlier quick preview/apply UI and write path are
replaced, so it cannot sidestep review. If a workspace with saved runs is
reopened without the feature flag, its run board is disabled and the quick
importer does not silently reactivate. Other workspaces keep the prior
importer. No input file, arbitrary system, host, connector, URL, credentials,
network discovery, background agent, sample values or external operation is
supported. This does not scan live systems or retry without an analyst.

## Verification

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules \
  node --test --test-concurrency=1 test/discovery-runs.test.js
```

Tests exercise scoped authentication and no quick bypass, concurrent queue
deduplication, partial state across a SQLite restart, one bounded resume,
reviewer-only approval, drift/reapproval and exhaustion, atomic map change,
v1→v2 field/provenance with stable IDs, and disabled-at-reopen behavior.
Chromium activates the actual rehearsal controls in two
local role contexts, sees drift refusal and reapproval, and opens the
updated inventory after reload. Remaining: a true background local job
worker, facility to retire an exhausted rehearsal, additional bounded
fixtures, alternate review outcomes, and browsers beyond Chromium.
