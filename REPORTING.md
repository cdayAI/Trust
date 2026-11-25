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
  intervening workspace changes may affect totals. This does not save or
  schedule report runs.

## Local HTTP

- `GET /api/reporting?dataset=records&workflow=rights&group=stage`
- `GET /api/reporting/export?dataset=activity&workflow=rights&group=outcome&format=csv`

Both routes accept `dataset`, `workflow`, `stage`, `outcome`, `group`,
`from`, and `to`. Only the export route accepts `format` (`csv` or `json`).
Invalid and duplicate filters return HTTP 422. Isolated mode also requires the
active workspace selector and an authenticated analyst or reviewer; report
state is never combined across workspaces. Demo mode uses only synthetic
records and keeps the usual local demo access behavior.
