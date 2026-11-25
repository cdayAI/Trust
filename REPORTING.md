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
  on the next successful pin. There are no scheduled checks or background sends.

## Local HTTP

- `GET /api/reporting?dataset=records&workflow=rights&group=stage`
- `GET /api/reporting/export?dataset=activity&workflow=rights&group=outcome&format=csv`
- `POST /api/reporting/runs` with `{"filters":{"dataset":"records","group":"stage"}}`
- `GET /api/reporting/runs` lists active pins. `GET /api/reporting/runs/:id` views one.
- `GET /api/reporting/runs/:id/export?format=json` downloads the same bytes, or use `format=csv`.

The live routes accept `dataset`, `workflow`, `stage`, `outcome`, `group`,
`from`, and `to`. Only the export route accepts `format` (`csv` or `json`).
Invalid and duplicate filters return HTTP 422. Isolated mode also requires the
active workspace selector and an authenticated analyst or reviewer; report
state is never combined across workspaces. Demo mode uses only synthetic
records and keeps the usual local demo access behavior.
