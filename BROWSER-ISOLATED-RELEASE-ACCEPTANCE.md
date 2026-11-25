# Isolated release navigation acceptance

This Chromium test launches the actual `start-release.js` composed local
release on an ephemeral loopback port. It creates a private temporary fixture
and uses that launcher's generated synthetic staff codes. It never opens an
existing workbench, production data, or a corporate identity provider. The
temporary release and browser contexts are closed and removed after the run.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules \
  node --test --test-concurrency=1 test/browser-isolated-release-nav.test.js
```

## What counts as exercised

- Every generated staff account/workspace membership signs in independently.
  The test compares the returned capabilities and visible tabs against an
  independent role matrix: analyst, reviewer, case operator, publisher,
  identity administrator, ethics investigator, and ethics reviewer.
- Each entitled top-level navigation control is activated by keyboard
  Enter. The destination must become the one active panel, retain the
  correct current marker, and render a specific role- or state-sensitive
  witness. Examples include the current workspace's project, incident and
  inventory label, a correct grouped report (two rights cases, one incident
  and one handoff), a delegated case-only view, and reviewer queue stages.
  Empty panes assert their actual release-specific empty state. Another pane
  being absent or awaiting data is not enough for a pass.
- Hidden tabs and their panels are checked on every membership. A
  representative authorized GET for each hidden, API-backed pane must be
  denied from the signed-in browser. For Assessments, which shares the
  permitted shell state endpoint, project, vendor, and assessment arrays
  must be empty for restricted roles. Restricted audit export gets its
  own denial assertion. Every membership checks cross-workspace state
  denial in addition to equivalent own-workspace success.
- A separate 390 px journey exercises signed-out skip/focus, the compact
  navigation disclosure, route focus transfer, the real Harbor analyst →
  Orchard reviewer workspace switch for the same seat, foreign workspace denial
  after switching, no horizontal overflow, and sign-out/401 from the
  former active workspace.

All data seeding uses authenticated loopback HTTP and is excluded from UI
activation counts. Browser route interception asserts no external workbench
requests; no uncaught page exception is permitted. Test output includes each
membership/view witness and counts rendered in-panel button, link, input,
select, textarea, and summary occurrences as **observed, not activated**.
Counts include repeated labels or control types across states.

## Verified count

The reviewed release run covered 14 account/workspace memberships across
seven roles: 128 top-level activations with a specific render witness,
292 hidden tab/pane checks, 282 representative denied view reads, 10
restricted assessment-state projections, 12 restricted audit-export
denials and 14 foreign-workspace checks. The compact journey is separate.
The same run **observed but did not activate 436 in-panel controls**,
including 14 disabled occurrences. These are occurrences across memberships,
not 436 unique controls or a statement of whole-product coverage.

## Coverage limits

This is complete only for the **top-level tabs exposed by the current generated
local release profiles**. It does not treat an observed in-panel control, link,
disclosure, upload, or download as exercised. The test does not enumerate
every dynamically created later lifecycle affordance, every empty/error/offline
state, every HTTP method or input, alternate browsers, screen readers,
real identity providers, external portal delivery, or production behavior.
Those belong to separate targeted journeys and specialist validation.
