# Browser acceptance and coverage ledger

Run the complete local suite with a known Chromium binary and an installed
Playwright package. The shell sets no credentials or external endpoints; the
suites create synthetic temporary stores and tear them down. The opt-in browser
suites are intentionally reported as skipped if the browser is not enabled.

```sh
NODE_PATH=/path/to/playwright/node_modules RUN_BROWSER_SMOKE=1 \
  CHROMIUM_PATH=/path/to/chromium npm test
```

Run the focused acceptance and inventory checks, optionally keeping the
generated JSON outside the repository:

```sh
NODE_PATH=/path/to/playwright/node_modules RUN_BROWSER_SMOKE=1 \
  CHROMIUM_PATH=/path/to/chromium QA_INVENTORY_FILE=/tmp/trust-control-inventory.json \
  node --test test/browser-acceptance.test.js
```

The inventory visits all currently declared workbench tabs under demo analyst,
reviewer and case-operator identities. It opens visible disclosures, records
visible button, link, input, select, textarea and summary instances, and
verifies each visible in-page JSON or CSV download once in the analyst
role. It additionally activates the shell audit export and parses its audit
array. On the reviewed baseline run the inventory found 51 view-role
combinations and 177 visible control occurrences, expanded 26 disclosures and
parsed six JSON downloads. Occurrences across roles are not counts of unique
controls. Seeded, disabled, role-gated and later lifecycle states must be tested
separately. An inventory entry marked `observed-not-exercised` is not a pass.

| Surface | Browser actions with executable evidence | Pending beyond that evidence |
| --- | --- | --- |
| Workbench shell | 17 top-level tabs in three demo roles, current indication, small viewport navigation, keyboard skip and focus transfer, solid surfaces | Supported screen readers, other browser engines, high zoom and additional device widths |
| Sign-in / workspace | Isolated sign-in, switch workspaces, scoped request behavior and sign-out, signed-out keyboard skip after the focus fix | Additional lifecycle account states and all error messages |
| Assessments / handoff | Seeded conditional answers, submit, review, simulated timeout/retry, download audit | Every edit/return reason and empty-state action |
| Audit management | Create a risk control and scoped plan, begin, block incomplete fieldwork in UI, record exception, submit, separate-account return, revise evidence and inspect prior versions, independent finalization, stale-tab error and reload, download and verify report digest | Alternate outcomes, every form validation, supersession |
| Work queue and reports | Open an assigned record, apply vendor filter, parse queue and shell exports; filter actual reporting data, choose grouping and download CSV on mobile | Filter combinations, each action link and all new reporting features |
| Rights / incidents | Rights create/verify/begin/fulfill; incident create and high-severity triage | Remaining decisions, review and response variants |
| Data mapping / discovery / dictionary | Add map inventory and inspect lineage, preview/apply discovery, publish a term; parse map and dictionary exports | Other association, conflict, change and retirement actions |
| Privacy notices / retention / risk / vendor | Privacy notices empty state; add retention fixture and preview; add a scored risk; start a monitoring cycle and open assessments; parse risks export | Remaining publication, hold, disposal, model, review and prevention states |
| Policies and documents | Draft and read a fictional document; exercise the file picker, accepted and rejected local text files, forced download, removal, reviewer publication and reload | Office/PDF attachment formats, malware scanning and broader upload cases are not implemented or certified |
| Workflow Studio | Publish and launch a pinned synthetic workflow, advance to review, see reviewer action; parse demo workflow audit export; isolated reviewer-only access is separately covered | Remaining transitions, failed validators, all recipes and role combinations |
| Requester, employee and visitor portals | Requester checks a code, submits one receipt and can clear it; employee no-assignment and clear flow; visitor opens empty published preview | Employee assignment and attestation in UI, all privacy requester and visitor publication states |
| Program modules | Open the page in each demo role and inventory the rendered actions | Every record collection and lifecycle operation |

## Known control-specific issue and regression

An isolated signed-out user previously received a skip link aimed at the
hidden workbench. Activating it updated the URL fragment but did not focus a
visible destination. The regression check expects a signed-out skip link to
focus the visible sign-in section, then Tab into the account field, and the
signed-in check separately asserts workbench focus.

The ledger is a starting inventory, not a claim that every control was tested.
Each newly added feature should add passing browser actions and explicit
denied/empty/invalid-state checks before being marked complete.

A supplementary axe-core scan of the 17 default demo analyst views in desktop
Chromium returned no automated violations under its WCAG 2.0/2.1 A/AA tags.
This is a scoped observation, not a conformance claim, and it does not replace
manual keyboard, screen-reader, state-specific and cross-browser checks.
