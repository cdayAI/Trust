# Composed release: conflicting incident and policy reviews

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test --test-concurrency=1 test/browser-release-incident-policy-stale.test.js
```

Four isolated Chromium contexts sign into the actual `start-release.js` launcher on a localhost port, with the temporary synthetic SQLite data it provisions. The HTTP fixture seeds the policy editors up to review and enters routine investigation evidence; the following transitions genuinely use the keyboard and forms, and assert resulting UI, response, or persisted state.

| Actual action | Witness |
| --- | --- |
| Log a Harbor incident before amendment | The case shows pinned version 1 and the exact immutable digest of its workspace's published policy. |
| Publish amendment from one reviewer tab and attempt conflicting Return from a stale tab | Independent publication activates version 2 while version 1's digest stays fixed. The stale action has the same revision and gets `409 STALE_REVISION`. The inline alert receives focus; Tab reaches Reload; Enter loads current policy, focuses the policy heading, and removes the obsolete return affordance. |
| Log a second Harbor incident, triage both as broad/low | New case pins version 2 with a different digest. Old case still requires the elevated investigation and uses 3/7-hour targets; new case follows standard investigation and uses 12/30 hours. |
| Supply old case's required impact reference and request review on both | Old case had no review affordance after general evidence alone. Both cases enter review, and their rendered timestamp equals the backend time calculated from their own pinned policy. |
| Return an incident for more information; attempt a contradictory simulated decision in stale tab | The return completes the review on time, does not start the notice clock, and stale required decision receives `409 STALE_REVISION`. Reload focuses the exact incident title, restores the actual review decision, and removes the outdated decision form. |
| Update findings, resubmit and independently record simulated “required” | Resubmission was unavailable before findings changed. The old case still uses a 3-hour review target and gets a 7-hour mock notice target. Work Queue uses that target's UTC date. |
| Record mock plan and reopen the incident | One local plan mutation and one plan audit event, both explicitly `sent: false`; review is `simulation-only`, the UI shows “not sent,” and the completed window and plan persist. Exact browser POST inventory contains only the expected local actions, and no off-origin requests were attempted by the browser contexts. |
| Sign in as Orchard reviewer | Shows the separate Orchard policy and incident, with its own version-1 digest, and neither Harbor case. |

The workflow covers 15 observed mutation POSTs, including two deliberate stale refusals. Keyboard disclosures, policy and incident reload affordances, and named field controls also have specific UI or state assertions; this is not a count of all controls. This case does not verify notification integrations, real legal deadlines, untested error/reload variants, other devices, or whole-platform accessibility.

**Narrow fix:** before the change, real Chromium received the expected stale policy response but focus fell back to `BODY` and its Reload action appeared only in the global notice. Stale policy and incident forms now put the error and explicit Reload together, focus the alert, and restore focus to the policy heading or affected incident after a successful refresh. No backend, pinning, policy, or notification behavior changed.
