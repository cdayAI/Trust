# Selected populated form accessibility checks

This check uses the actual composed localhost release, isolated generated
synthetic roles, pinned axe-core 4.14.1, and desktop Chromium at 1440×1000.
The two audited surfaces are the populated evidence-hold decision forms
and operational reporting filters/results. No production data, external
requests, or requester panel changes were involved.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules \
  node --test --test-concurrency=1 test/browser-release-evidence-dispute.test.js \
  test/evidence-holds.test.js test/reporting.test.js
```

| State | Baseline finding and narrow correction | Executable witness |
| --- | --- | --- |
| Evidence hold, both independent review decisions expanded, Glass and Solid | The accessibility tree gave both reason comboboxes the same name and provided no named form boundary. Each decision and reason now has a contextual name. | Approve and Keep are separately named by action (form names also include edition and revision), and each named form contains its one matching reason and submit button. Space and Tab traverse the intended form. Axe scans both modes while both forms are open. |
| Evidence hold, reviewer submits **Keep** | Focus fell to the document body after the UI replaced the form. | Keyboard Enter restores focus to the specific edition’s preservation heading; its described state is **Hold active**. |
| Reporting, populated filters, live result table and schedule disclosure, both modes | Axe left the translucent disclosure’s contrast undecided; this was not a measured baseline contrast failure. The schedule disclosure now has explicit opaque colors. | Normal text ratio is 12.69:1 from computed foreground/background, against a 4.5:1 threshold, and axe evaluates contrast in both modes. Filters have unique names and the fixture still gives two records. |
| Reporting, reversed UTC range entered, both modes | Before, Apply kept focus and the generic status was not associated with either date. | Inline text with an alert role describes the invalid end date, focus lands there, and no network request is made for the reversed range. The last valid result stays on screen. Correcting the range clears the announcement/invalid marker, re-runs the report once, and restores Apply focus. |

Axe runs rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, and `wcag21aa`.
The reviewed run had zero violations and zero incomplete results in six
state/mode combinations. Applicable checks included `color-contrast`,
`button-name`, `select-name`, `summary-name`, `label`,
`form-field-multiple-labels`, ARIA reference and naming rules, and the
report table header checks. Keyboard assertions and identical live-report
counts are separate from axe. Baseline automated scans did not identify
the duplicate contextual names or dropped keyboard focus; those were
confirmed by Chromium's accessibility tree and DOM focus.

This result is for these populated states and the selected axe tags only.
It does not establish WCAG conformance, robust announcements across screen
readers, zoom/forced-colors performance, every form error, other browser
engines/devices, or whole-platform accessibility. The hold panel, general
report scheduling workflow, file picker, and release role checks have their
own independent acceptance tests; this is not a substitute for manual
assistive-technology evaluation.
