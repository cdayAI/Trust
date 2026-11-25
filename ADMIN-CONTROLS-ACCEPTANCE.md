# Governed workflow, administration, assessment, and reporting browser acceptance

This local Chromium suite uses fictional records and independently signed-in
roles in separate browser contexts. Authenticated loopback HTTP prepares some
prerequisites (explicitly identified below); those API calls are not counted as
UI activations. The test diagnostics list each activated control occurrence and
its witness, and report separate availability-only checks. Repeated actions
such as signing in or reopening a pane do not represent different controls.
The tests also check for uncaught page errors and external requests.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/browser-admin-controls.test.js
```

| Surface | Newly exercised browser controls | Not covered here |
| --- | --- | --- |
| Workflow studio | Publisher loads a recipe, changes display name, adds/removes a state and transition, confirms and publishes v1, views its role/transition details, forks and publishes v2. Analyst selects v1, starts a pinned instance, submits, and resubmits after a separate reviewer returns it. Reviewer selects the exact instance, supplies the reason, approves, and opens the JSON download. The artifact proves the four accepted transitions and exact actor order. | Other recipe graphs, arbitrary transition editing and browser stale-transition errors; HTTP tests cover missing fields, stale revisions and role refusals. |
| Identity administration | Dedicated admin opens re-enable and revoke forms, chooses audit reasons, confirms each action, sees revision/audit state, and regains heading focus. A preexisting north analyst tab is sent to sign-in after session revocation; an independent south tab remains available. North sign-in works again without restoring the old session. Disable is set up over HTTP, since existing browser tests exercise that control. | Provision-disabled/expired identity rows, admin self-management absence beyond the protected seat indicator, multi-tab logout and stale concurrent roster editing. |
| Group governance | With grants prepared using independent HTTP roles, administrator opens one app grant's revoke disclosure, confirms, and verifies focus. Operator refreshes scoped apps to observe only the other grant, then refreshes when that separately granted app expires while membership remains approved. Admin sees expired state without revoke and confirms archive. | Reviewer rejection and re-proposal after expiry in the browser; baseline Chromium covers initial proposals and approval. No third-party app execution. |
| Assessment questionnaires | Uses independently released fictional PIA/DPIA configuration and HTTP-seeded intake. In real workbench UI, analyst opens both routes, saves conditional PIA draft, safely reloads a stale tab and verifies committed answers, hides and clears the PIA branch, checks numeric DPIA browser validation, submits, receives a separate reviewer's return, edits and resubmits without stale hidden answers, and reviewer approves. | Config editor ordering/removal, alternative rules and old configuration editing; the independent configuration browser test covers initial authoring and first publish. |
| Reporting | Isolated reviewer sets audit outcome, workflow, grouping, and exact UTC date range; sees two matched refusals. Edits an unapplied outcome and clicks both real CSV and JSON downloads. Both contain the same known applied numeric aggregate and exclude fixture IDs and note. Reset clears both date inputs and restores focus. | Multi-day grouped percentages and invalid date range UI, role-specific no-access behavior beyond existing API checks. The separate reporting browser test covers mobile and records-stage CSV. |

Related evidence: `BROWSER-ACCEPTANCE.md`, `WORKFLOW-ACTIONS-ACCEPTANCE.md`,
and `PORTAL-CONTROLS-ACCEPTANCE.md`. This is not complete browser coverage or
enterprise validation. No deployment or real credentials were used.
