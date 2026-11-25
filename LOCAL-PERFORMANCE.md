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
