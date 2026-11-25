# Operational reporting

Open **Reporting** in MVW Trust to build and download a workspace report. The
report reads the same records and audit activity as the applicable workflows.
It contains aggregate counts only, not record titles, IDs, account details,
form answers, requester notes, evidence contents, or audit payloads.

- **Workflow records** counts current assessments, project handoffs, rights
  cases, incidents, vendor-monitoring cases, privacy notices, retention schedule
  versions, governance documents (one current revision per document), and
  audit plans. Filter by current stage. Date filters use when the underlying
  record was created or opened, not when it last changed. The current stage
  does not reconstruct historical state. Assessment and handoff creation dates
  come from assessment and project creation events.
- **Audit activity** counts persisted events for those workflow areas only.
  Filter by recorded, refused, or failed outcomes. Recorded does not mean
  approved: a completed reviewer action can record a return. A failure not
  written to the audit log will not appear in an activity report. This excludes
  session events, separate workflow-studio histories, legacy records, and areas
  outside the selected scope.
- Use **Workflow**, **Current stage** (records only), **Event outcome** (activity
  only), **UTC day**, or **UTC month** as the grouping. Dates are inclusive UTC
  calendar dates. Rows with an unavailable source date appear as *Undated*
  without a date filter and are excluded when either date bound is set.
- Downloads use the last applied filters. JSON includes grouped rows and totals.
  CSV repeats the selected dimensions on every row and contains a header with
  no data rows for an empty result. Downloads are recomputed when requested;
  intervening workspace changes may affect totals.
- **Pin current report** takes a fresh snapshot with the last applied filters,
  then opens that saved run. Its viewer and JSON download use the same stored
  bytes; its CSV is captured with those same rows at pin time. Later record and
  audit updates do not change it. Open an older version under **Pinned reports**.
- Pinned runs are visible to analysts and reviewers of the same workspace. They
  expire after 30 days. New runs can remove the oldest sooner to keep no more
  than 30 runs or 1 MiB of stored export bytes; a single run is limited to 256
  KiB. Expired runs immediately stop opening, and their stored bytes are pruned
  on the next successful pin. Nothing is sent. The optional local schedule
  worker can create pins only when explicitly enabled and approved.

## Local schedule simulation

Under **Reporting → Local report scheduling**, an analyst proposes one plan
from an available pinned report. The current UTC daily or weekly cadence,
first slot, and exact normalized template filters are fixed for that plan.
A separate reviewer approves it. The plan's first UTC slot can be at the
current minute or up to 366 days ahead. A reviewer can stop a draft or active
plan without removing its receipts, after which an analyst can propose a
replacement. A workspace stores at most eight plans.

**Run simulated slot** is a deliberate local test, not an automatic job.
The caller selects a simulated UTC time and explicitly targets the next
displayed slot. If it is not due, no report is written. A due tick captures
the current workspace, not its historical or future state, and saves the
result through the existing pinned-report engine. The result has its own
immutable JSON and CSV exports, actual capture time, and slot receipt.
Repeated hits on the same slot never create another report or run a
different slot. Each successful test advances the due time exactly one UTC
day or seven UTC days. It never sweeps missed slots automatically.

The most recent 24 receipts per plan remain after restart. Receipt metadata
may outlive report bytes governed by the ordinary pinned-report limits.
An older processed slot cannot run again after its receipt or bytes expire.
No recipients, real sending, outbound network actions, rolling filters, or
corporate sign-in integration are supported. The panel and routes require an
authenticated analyst or reviewer in a local isolated synthetic workspace.

## Opt-in local report worker

The worker is **off by default**. Enable it only in an isolated synthetic
workspace on a disposable local SQLite database, for example:

```sh
TRUST_SQLITE_FILE=/path/to/local-fixture.sqlite \
TRUST_LOCAL_REPORT_WORKER_WORKSPACE=harbor npm run start:isolated
```

Choose one exact workspace ID (`harbor` or `orchard` with the bundled
launcher). JSON storage, demo, and corporate sign-in cannot run this worker.
It only runs while the named workspace's loopback server is up. Use an
unset flag to disable it on restart without changing existing history.

In Reporting, the analyst must explicitly choose **Approved local worker**
before proposing the plan. A separate reviewer approves that execution
mode. Previously approved manual plans remain manual; enabling the worker
does not change their approval. A reviewer may stop the worker plan from
the same panel. Approving or running one workspace does not affect another.

About once a minute, the worker checks the actual UTC clock and saves at most
one due slot through the normal immutable report store. Manual retries use
the same slot and cannot run a worker plan ahead of actual UTC time. Changing
the host clock backwards or restarting does not rewind the saved cursor or
duplicate a report. After long downtime the worker keeps at most the latest
seven due slots, records the omitted range and cumulative count, and captures
one slot per wake in ascending order. Skipped slots cannot be replayed.

Automatic receipts and audit entries identify the system as executor and
show the slot, capture time and matching-record count. If the export exceeds
the pin limit the worker records one held outcome without advancing. Staff
can retry a due slot manually once the result fits, or stop and replace the
plan. There are no delivery addresses, external requests, messages, or
production-daemon guarantees.

## Local HTTP

- `GET /api/reporting?dataset=records&workflow=rights&group=stage`
- `GET /api/reporting/export?dataset=activity&workflow=rights&group=outcome&format=csv`
- `POST /api/reporting/runs` with `{"filters":{"dataset":"records","group":"stage"}}`
- `GET /api/reporting/runs` lists active pins. `GET /api/reporting/runs/:id` views one.
- `GET /api/reporting/runs/:id/export?format=json` downloads the same bytes, or use `format=csv`.
- `GET /api/reporting/schedules` lists local plans, draft revision, and retained receipts.
- `POST /api/reporting/schedules/create` takes `expectedRevision`, `sourceRunId`, `cadence` (`daily` or `weekly`), and `firstDueAt` (canonical UTC at a whole minute, for example `2027-03-01T09:00:00.000Z`). Optionally send `execution: "local-worker"` only in the named, enabled workspace; omitting it remains manual.
- `POST /api/reporting/schedules/approve` and `/stop` take `expectedRevision` and `planId`.
- `POST /api/reporting/schedules/tick` takes `planId`, the exact `slotAt`, and canonical UTC `simulatedAt`.

The live routes accept `dataset`, `workflow`, `stage`, `outcome`, `group`,
`from`, and `to`. Only the export route accepts `format` (`csv` or `json`).
Invalid and duplicate filters return HTTP 422. Isolated mode also requires the
active workspace selector and an authenticated analyst or reviewer; report
state is never combined across workspaces. Demo mode uses only synthetic
records and keeps the usual local demo access behavior.
