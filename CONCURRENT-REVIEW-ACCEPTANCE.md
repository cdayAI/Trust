# Concurrent reviewer and retention recovery browser evidence

These are two fictional Chromium journeys over a local SQLite-backed isolated
workspace and generated sign-in codes. Prerequisite records are prepared via
authenticated loopback HTTP and do not count as UI coverage. Separate browser
contexts deliberately overlap; the two notice tabs are independent sessions
for **the same authorized reviewer seat**, not two people with concurrent
reviewer memberships. Important controls are activated with Space, Tab, and
Enter, with a correlated mutation response or specific DOM/focus assertion.
Each journey uses a real server restart and fresh sign-in to verify persisted
outcomes, and checks for no page errors or external requests.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/browser-concurrent-review.test.js
```

| Journey | Verified control and persistence evidence | Remaining coverage |
| --- | --- | --- |
| Notice overlap and replacement | Both reviewer sessions open the same pending web revision. Keyboard opens Publish and Return disclosures, tabs to the notes and commits. First publication returns 200; the old Return returns 409 with `STALE_REVISION`. Reload shows the winning rationale and no review controls, earlier web copy stays readable as history, and the separate mobile edition remains current. Reopening after a SQLite restart shows exactly one winning publish audit event, a stale refusal, and no Return. | Independently assigned multiple reviewers (not supported by this seat model), exact simultaneous submit scheduling, connected-TV/service-desk channel variants, and other input validation or assistive technologies. |
| Retention supersession and recovery | Independent reviewer activates v2 from the keyboard. An already-open v1 simulation reports 409; Reload retention renders v2 Current. The v1 preview now explains why it is historical and no longer offers a dead simulation action. Keyboard opens the same fixture’s new preview and focuses the original date. Saving produces the exact v2 closing-date calculation, then only v2 records an anonymization simulation. A real restart retains one audit-only result while the all fixture fields remain identical in the read model. | Duplicate dispositions during simultaneous fresh runs, multi-hold release combinations, alternative triggers/dispositions beyond the fixture, and other browser engines/assistive technology. The existing stateful suite separately exercises blocking on a hold. |

## Reproduced product defect and narrow fix

Before the change, Chromium showed one enabled **Record audit-only simulation**
button on a known-superseded preview after **Reload retention** had already
loaded the new active schedule. The server refused stale attempts correctly.
The UI now uses the current category schedule already in its response to
replace that dead end with a historical note and **Create updated preview**.
The action only opens the fixture editor and moves focus; the analyst still
chooses whether to save and simulate. The server's validation, persisted
preview, recorded audit data, and disposition behavior are unchanged.
