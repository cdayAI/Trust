# Local synthetic operator API

Start the isolated workbench with transactional SQLite.

```sh
TRUST_SQLITE_FILE=/path/to/private/trust.sqlite npm run start:isolated
```

Use the printed loopback address and generated private access file. POST JSON to
`/api/session/login` with the account, its code, and its workspace. Save the
session cookie from the response and send it on later calls. Use separate
sessions for the analyst and the human reviewer. Keep the reviewer code and
session with the person making the approval decision. Restarting the launcher
regenerates codes and sessions. Sign in with the current codes to resume jobs
under the same account IDs and SQLite file.

All POSTs require `Content-Type: application/json` and an `Origin` equal to the
printed base URL. Add exactly one `?workspace=harbor` or `?workspace=orchard` to
operator requests, matching the active session. Use synthetic records only. The
operator routes are enabled in isolated SQLite mode. In the workbench, analysts
and reviewers can queue, inspect and act on their jobs from **Operator jobs**.
Open **Queue operator job** on a card in **Audit management** to fill in that
plan’s ID and revision. From a job, **Open audit plan** or **Open rights case**
takes the reviewer to the underlying record before they decide.

## Endpoints

| Method and path | Request | Access and result |
| --- | --- | --- |
| `POST /api/operator/v1/jobs` | `action`, `args`, `idempotencyKey` | Submit a job. Returns `201` for a new job or `200` with the current job for an identical replay. |
| `GET /api/operator/v1/jobs` | | Returns `{"jobs":[...]}`. Analysts see their own jobs. Reviewers see their own jobs and the workspace’s state-changing proposals and outcomes. |
| `GET /api/operator/v1/jobs/{id}` | | Returns `{"job":{...}}` under the list’s visibility rules. |
| `POST /api/operator/v1/jobs/{id}/decision` | `{"decision":"approve"}` or `{"decision":"reject"}` | An independent reviewer decides a state-changing proposal. Repeating the same decision returns the current job. |
| `POST /api/operator/v1/jobs/{id}/run` | `{}` | The submitting account runs a queued job. Returns the current committed job on replay. |
| `POST /api/operator/v1/jobs/{id}/retry` | `{}` | For receipt rehearsal only. The submitting analyst runs the single approved retry after the first attempt fails before the effect. |
| `POST /api/operator/v1/jobs/{id}/reconcile` | `{}` | For receipt rehearsal only. The approving reviewer verifies the local receipt after an uncertain outcome. |

Each single-job response uses `{"job":{...}}`. The job contains a server-issued
`id`, the action and arguments, `requestedBy`, status, and timestamps. Where
applicable it includes `decision` (`value`, `by`, `at`), `result`, or
`failure` (`code`). The server-issued ID is also `correlationId` on the job’s
workspace audit events and on the domain change or recorded refusal.
Reviewers can retrieve these via `GET /api/audit/export?workspace=harbor`.

Generate a fresh random lowercase UUIDv4 for each distinct job. Reuse it when
retrying that job, including after signing in again. Keys are scoped to the
authenticated account within its workspace. Reusing a key for a different
action or argument value returns `409 IDEMPOTENCY_CONFLICT`. The API and audit
omit the key and the stored key digest. To submit a new attempt after a domain
failure, inspect the current case and use a new key.

## Allowlisted actions

| Action | Arguments | Roles and effect |
| --- | --- | --- |
| `rights.case.status` | `{"caseId":"<case UUIDv4>"}` | Analyst or reviewer. Starts queued. Returns the case ID, kind, owner, status, and revision captured at execution. |
| `rights.case.assign` | `{"caseId":"<case UUIDv4>","expectedRevision":1}` | Analyst submits. Independent reviewer must approve. The analyst runs the job. The existing rights workflow reassigns the case to the synthetic `case-operator` using the expected revision and a fixed synthetic audit note. |
| `audit.plan.status` | `{"planId":"<plan UUIDv4>"}` | Analyst or reviewer. Starts queued. Returns the plan ID, status and revision captured at execution. |
| `audit.plan.begin` | `{"planId":"<plan UUIDv4>","expectedRevision":1}` | Analyst submits and runs after independent reviewer approval. The existing audit workflow checks the revision and starts fieldwork on a planned audit. |
| `audit.plan.receipt-rehearsal` | `{"planId":"<finalized plan UUIDv4>","expectedRevision":5}` | Analyst submits and runs after independent reviewer approval. Rehearses recording a synthetic local receipt for the exact finalized revision. |

For a complete example, open a fictional rights case owned by the analyst using
the workbench. Take its ID and revision from the case screen or
`GET /api/rights/cases?workspace=harbor`. Submit a reassignment using that ID
and revision with a newly generated UUIDv4:

```json
{
  "action": "rights.case.assign",
  "args": {
    "caseId": "03f34a88-d27c-42de-b88d-8f033082ad16",
    "expectedRevision": 1
  },
  "idempotencyKey": "1f686c71-4e98-4ce9-aaa6-642edabc79c3"
}
```

The job starts in `awaiting-approval`. The reviewer opens it and approves it
after checking the record and proposed revision. Approval queues the job. Rejection ends it in
`rejected`. The analyst then posts to `/run`. Execution is explicit and
finishes within one local transaction. A completed job is `succeeded` or
`failed`. For example, a stale case revision returns a failed job with
`STALE_REVISION` and keeps the domain refusal in the audit. A run
before approval or after rejection returns `409 JOB_NOT_RUNNABLE`.
Unrecognized input returns `422`. A job outside the caller’s visibility
returns `404`. An unauthenticated request returns `401`, and a disallowed role
or mismatched active workspace returns `403`.

The queue, domain records and audit history share the existing workspace snapshot and
SQLite transaction. A failed storage write leaves the queued job available to
retry. This local slice uses explicit requests for approval and execution.
For an audit proposal, take the plan ID and revision from **Audit management**
or `GET /api/audit-management?workspace=harbor`. Queue and review
`audit.plan.begin` using the same steps. The analyst’s run moves a planned
audit to fieldwork and returns the new revision. Audit findings, scope text
and evidence stay in the audit workbench. The job API returns plan metadata.

## Rehearse a finalized audit receipt

In **Audit management**, open **Queue operator job** on a finalized audit plan
to prefill **Rehearse audit receipt**. The analyst submits the exact plan
revision and the reviewer approves it. A plan revision can have one active
rehearsal or one recorded receipt. Replaying the original submission key
returns its existing job.

1. The analyst selects **Run job**. Attempt 1 records a simulated temporary
   failure before a receipt is written. The status becomes `retryable`.
2. The analyst selects **Retry job**. Attempt 2 atomically records a synthetic
   receipt and marks its acknowledgment uncertain. The status becomes
   `needs-reconciliation`. Repeating Run or Retry returns the current job and
   consumes no additional attempt.
3. The approving reviewer selects **Reconcile receipt**. This verifies the
   matching receipt in SQLite and returns its ID with status `succeeded`.
   Repeating reconciliation returns the same result.

The two attempts, the original approval, and any reconciliation survive a
restart. Only the independent approving reviewer can reconcile. A missing
receipt leaves the job awaiting reconciliation. The effect writes only
synthetic identifiers, a revision, and a timestamp to the local SQLite ledger.
