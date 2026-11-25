# Composed release: competing report schedules

Run the focused browser journey on the actual synthetic SQLite launcher, using one worker:

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test --test-concurrency=1 test/browser-release-report-schedule-race.test.js
```

The test starts `start-release.js --port 0` in a temporary directory, uses issued local test seats in five isolated browser contexts, blocks off-origin traffic, and removes its fixture on exit. Normal HTTP seeds two pinned aggregate templates and adds two fictitious incidents; schedule changes and file deliveries use the real UI. No recipient is configured, and no send or external service runs.

| Actual interaction | Outcome checked |
| --- | --- |
| Each sign-in, keyboard Reporting navigation and scheduling disclosure | Selected role/workspace gets the ready reporting and schedule panels; the Orchard reviewer sees no Harbor plan or download. |
| Select distinct pinned templates, cadences and due times, then submit in two analyst tabs | The first proposal persists exact incident/stage filters. A concurrently prepared rights/weekly proposal receives `409 STALE_REPORT_SCHEDULE`; reload shows only the winning plan and removes the proposal affordance. |
| Activate Approve in two reviewer tabs | First succeeds for the exact draft; second sends the same revision and receives `409 STALE_REPORT_SCHEDULE`. The focused in-panel alert containing the server message is followed by Reload in the Tab order. Reload focuses the scheduling heading, shows the active plan and removes both the obsolete approval and error. |
| Activate Run simulated slot from analyst and reviewer contexts holding the same UTC slot | Both POSTs send the same slot; outcomes are exactly one `ran` and one `already-run`, with the same receipt ID. The UI shows the correct outcome, success focus, the one-slot cursor advance, and one downloadable receipt. Persisted pins and audit each show only one capture. |
| Activate scheduled JSON and CSV | The actual browser downloads have the receipt ID, workspace scope, file names, aggregate filters and row/count known from the fixture. No source incident text is included. |
| Stop, reload, and propose a different scope | The stopped daily plan keeps its receipt. A new weekly rights draft has its own ID and exact different filters. Both downloaded byte streams remain identical after a later incident, replacement proposal and reload; independent HTTP reads match those bytes. Orchard receives not found when requesting the Harbor receipt in Orchard's own scope. |

This adds 42 witnessed control uses (excluding credential entry), not 42 unique controls. It complements `test/report-schedules.test.js` rather than replacing the separate cadence, bounds, restart, early-slot and dedicated happy-path coverage there. It does not establish real scheduled execution, cloud delivery, exhaustive browser/device coverage, or full accessibility conformance.

**Reproduced and fixed:** before this change, the keyboard-triggered stale approval returned the expected 409 but dropped focus to `BODY` after disabling the submit control; there was no focused recovery in the open panel. A schedule mutation failure now focuses an inline alert immediately before Reload without auto-retrying, discarding the user's draft, changing reports, or affecting other panels. Reload remains explicit and removes stale controls on successful refresh.
