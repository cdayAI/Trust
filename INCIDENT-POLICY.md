# Synthetic incident response policy

In **Incidents**, the analyst can draft a policy, edit the routing table, and
submit it for independent review. Only a separate reviewer may return or
publish a version, with a fictional rationale. The current published version
remains active while a draft is edited or reviewed. The published matrix is
immutable and has a SHA-256 identifier; up to 32 versions are stored per
workspace. The feature is limited to the local synthetic workbench.

Each policy specifies exactly one route for every combination of severity
(low, moderate, high, critical) and classified scope (limited, broad, unknown).
A route specifies standard or elevated investigation and two target windows.
High and critical severity cannot be downgraded from elevated. Standard
investigations need containment, findings, and at least one distinct evidence
reference. Elevated investigations need two references, including one for
impact. Both require independent notice review.

Cases opened after a policy is published are pinned to that exact version and
hash at intake, before triage. If an older API client omits the scope class,
the case uses **Unknown**. The analyst may reclassify the scope as evidence
develops before review; routing still uses the same pinned matrix. Later policy
changes do not affect pinned cases. Cases
opened without a published policy retain the original severity-only routing
and have no configured windows.

* **Review target**: starts when the analyst requests independent review
  (1–168 hours). If a reviewer asks for more information, a new target starts
  only after documented investigation updates and resubmission.
* **Mock notice target**: starts only after the reviewer records a simulated
  required decision (1–720 hours). A mock plan is required before closure;
  recording one does not send anything.
* Times and outcomes are calculated in UTC. The case shows the exact target
  moment and whether completion was on time. The Work queue uses its UTC
  calendar date while the corresponding action is pending. Missing a target
  does not advance, close, or block a case; it remains visible for manual work.

Only original fictional inputs should be used. The routes and timers are
internal simulation targets, not statutory deadlines, legal determinations,
automated alerts, or an external incident notification service. Nothing is sent.

Run the isolated SQLite and Chromium journey with:

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test test/incident-policy.test.js
```
