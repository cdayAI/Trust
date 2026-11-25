# Local performance checks

Run a synthetic benchmark against the current source checkout or the extracted local release:

```sh
npm run benchmark:local
npm run benchmark:local -- --records 1200 --samples 45 --concurrency 1
npm run benchmark:local -- --backend json --records 900 --samples 24 --concurrency 4
```

The script creates its own temporary directory, storage files, and disposable sign-in codes. It listens on random loopback ports, never accepts a network destination or path to existing data, and does not use environment-provided storage files or keys. It seeds equal numbers of fictional projects and privacy rights cases, with matching audit events and mixed assignment/stage. It checks workspace boundaries, role denials, and the final committed write count. Cleanup runs on normal completion and test failure. As with other temporary files, an interruption that kills the process outright can leave its `mvw-local-bench-*` temporary directory for manual cleanup.

By default the script tests both demo and isolated modes, with the same fixture for JSON and SQLite. It exercises the workbench-state response, record and audit aggregate reports, reviewer-filtered queue, isolated session/role lookup, case operator's personally assigned queue and analyst intake writes. Each endpoint has four warm-up requests excluded from metrics, then reports measured sample count, p50/p95/p99 milliseconds (nearest rank), request throughput and the final response's UTF-8 byte count. Node/platform, initial data size, startup and total writes are included. Flags cap fixture size at 1,500 projects and 1,500 rights cases, sample count at 100 per operation and concurrency at four clients. The HTTP workload has a one-minute abort deadline. Use `--backend json` to run only the JSON baseline.

## Reading the output

- Compare the same Node release, hardware, storage location, fixture size, sample count and concurrency. For before/after comparisons, copy the benchmark script unchanged to the earlier tree and repeat each run several times. Keep other work idle where possible.
- Timings cover same-host request handling, full body transfer and client JSON parsing in one Node process. Tail measurements can be distorted by GC, scheduling, cold caches or concurrent local work. Do not set infrastructure budgets or claim a production SLA from these runs.
- Unchanged SQLite membership lookups now check the committed snapshot generation without parsing the workspace. A committed change refreshes the small identity projection, so revocations are not cached past the next request. Reports get state and visible audit rows from one read. Queue filters discard excluded work before sorting and count included items once.
- SQLite still stores one transactionally committed workbench snapshot per scope. Encoding, synchronous durability and large result bodies still matter on writes; `/api/state` and other wide views may dominate larger runs. JSON is a local single-process fallback. Do not infer write capacity, multi-host compatibility, durable shared sessions or production readiness from this benchmark.
- Regression tests assert output invariants and immediate cross-connection revocation, not millisecond targets that could fail spuriously on shared runners.

## Signed-in Home startup

Signed-in Home requests the session and scoped Home summary; the larger
assessment snapshot is loaded only when an assessment workflow needs it.
Role and workspace checks are unchanged. An assessment load failure leaves
workspace navigation available and can be retried from the assessment view.

Two interleaved loopback Chromium comparisons used identical synthetic
SQLite workspaces with 500 projects, 500 rights cases, and 1,125 audit events.
Each run measured 24 Home-ready navigations per version after four warm-ups
per version, in one browser. In both runs, decoded startup API bodies were
529,201 bytes before and 1,284 bytes after. The first Assessments visit still
requested the unchanged 527,917-byte snapshot. These counts exclude assets
and HTTP framing.

| Run | Home-ready median, before → after | Home-ready p95, before → after |
| --- | ---: | ---: |
| 1 | 84.0 → 72.7 ms | 463.5 → 234.8 ms |
| 2 | 93.1 → 80.9 ms | 148.9 → 112.6 ms |

The repeatable result is the eliminated startup fetch. Browser timings are
illustrative, depend on scheduling, and are not production or comparative
vendor measurements.

## Signed-in staff rights intake

The existing `POST /api/rights/cases` request still returns the complete scoped
queue by default. An authenticated analyst can opt into
[`Prefer: return=minimal`](https://www.rfc-editor.org/rfc/rfc7240.html#section-4.2);
a successful compact request returns `201`, `Preference-Applied: return=minimal`,
and only the new case and its applicable delegation summary.

Where safe, a fresh analyst queue response provides an opaque
`X-MVW-Rights-View-Version` header. The browser sends this with its intake
preference. The server checks the token against the write transaction's
snapshot and the currently applicable UTC and delegation visibility. If it
does not match, the normal full authorized queue comes back in the same
response. A valid delta updates one card and needs no follow-up request.
Workspaces with dynamic requester result bindings use the full queue for the
browser. If a network fault makes a submission ambiguous, reload the list
before resubmitting rather than retrying the write automatically.

One interleaved localhost Chromium comparison used separate, identical SQLite
fixtures initially containing 500 projects and 500 rights cases. The first
intake response was 912,649 bytes before and 1,477 bytes after; neither
version added a queue GET after opening the Rights view. Across 13 measured
intakes per version after four per-version warm-ups, median click-to-card
time was 915.5 ms before and 178.0 ms after; p95 was 1760.2 ms and 311.2 ms,
respectively. Payload sizes exclude HTTP framing. Click-to-card includes
browser work and local scheduling; these are illustrative fixture timings,
not production or vendor benchmarks.

## Work queue page size

The workbench shows 25 tasks per page while keeping the counts for all
matching work. Open a record from any page or export every matching task as
before. Reads without a page limit retain their original full response.

The optional HTTP contract is `GET /api/work-queue?limit=25` plus the existing
owner, workflow and timing filters. A limit can be 1–100. Repeat the same
limit and filters with a returned `pagination.nextCursor` or
`pagination.previousCursor`. The cursor applies only to the current
authorized workspace, role, UTC date, and matching task projection. A
changed queue or server restart returns `409 QUEUE_CURSOR_STALE`; restart
from a request without a cursor. Export never takes a cursor or limit.

With identical localhost SQLite fixtures (500 projects and 500 rights
cases), Chromium's first queue response fell from 238,443 to 13,074 bytes
and the DOM from 500 to 25 task cards. Actual Next and Previous returned
13,193 and 13,074 bytes, respectively, and matched the corresponding
slices of the full response. Over 13 interleaved measurements per version
after four warm-ups, median click-to-queue was 127.8 ms before and 82.7 ms
after; p95 was 157.1 and 114.9 ms. Timings are illustrative local samples,
not production or vendor benchmarks. The server still derives and sorts
the complete matching queue to preserve counts and cursor consistency.
