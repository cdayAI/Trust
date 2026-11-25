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
operator routes are enabled in isolated SQLite mode.

## Endpoints

| Method and path | Request | Access and result |
| --- | --- | --- |
| `POST /api/operator/v1/jobs` | `action`, `args`, `idempotencyKey` | Submit a job. Returns `201` for a new job or `200` with the current job for an identical replay. |
| `GET /api/operator/v1/jobs` | | Returns `{"jobs":[...]}`. Analysts see their own jobs. Reviewers see their own jobs and the workspace’s reassignment proposals and outcomes. |
| `GET /api/operator/v1/jobs/{id}` | | Returns `{"job":{...}}` under the list’s visibility rules. |
| `POST /api/operator/v1/jobs/{id}/decision` | `{"decision":"approve"}` or `{"decision":"reject"}` | An independent reviewer decides a reassignment. Repeating the same decision returns the current job. |
| `POST /api/operator/v1/jobs/{id}/run` | `{}` | The submitting account runs a queued job. Returns the committed terminal job, including on replay after success or failure. |

Each single-job response uses `{"job":{...}}`. The job contains a server-issued
`id`, the action and arguments, `requestedBy`, status, and timestamps. Where
applicable it includes `decision` (`value`, `by`, `at`), `result`, or
`failure` (`code`). The server-issued ID is also `correlationId` on the job’s
workspace audit events and on its rights case change or recorded refusal.
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
after checking the case. Approval queues the job. Rejection ends it in
`rejected`. The analyst then posts to `/run`. Execution is explicit and
finishes within one local transaction. A completed job is `succeeded` or
`failed`. For example, a stale case revision returns a failed job with
`STALE_REVISION` and keeps the rights workflow’s refusal in the audit. A run
before approval or after rejection returns `409 JOB_NOT_RUNNABLE`.
Unrecognized input returns `422`. A job outside the caller’s visibility
returns `404`. An unauthenticated request returns `401`, and a disallowed role
or mismatched active workspace returns `403`.

The queue, rights records and audit share the existing workspace snapshot and
SQLite transaction. A failed storage write leaves the queued job available to
retry. This local slice uses explicit requests for approval and execution.
Existing interactive rights endpoints retain their own authorization and
review rules. The API accepts only case IDs, revisions, operation names, and
opaque retry keys. Its results contain synthetic case metadata.
