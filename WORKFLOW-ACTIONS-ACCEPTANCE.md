# Stateful browser control acceptance

These Playwright journeys use new temporary local datasets and fictional
content. They drive actual workbench UI controls; no records are seeded by
directly editing a store. The runner prints a control-to-outcome witness
list for each test. These are tested stateful paths, not a claim of complete
control or validation coverage.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/browser-workflow-actions.test.js
```

| Surface | Actively exercised controls and outcomes | Remaining beyond this pass |
| --- | --- | --- |
| Privacy notices | Open panel, draft and set scope/channel/text; create, submit, independent return with rationale, edit, save, resubmit, publish locally; create next draft while published version stays current. Author cannot see publish control. | Stale-tab reload and alternative channel/duplicate/version refusal paths in browser. |
| Retention | Draft, edit, submit, reviewer return, resubmit, activate; add fixture, view eligible preview, add hold, record-simulation button refuses a pre-existing preview; save blocked preview, independent release, then record audit-only simulation and verify fixture stays unchanged. | Stale-tab reload, multiple holds, closing-date trigger and alternative dispositions in browser. |
| Vendor monitoring | Select existing vendor, open case, alter tier inputs, record evidence, open linked assessment, submit and approve independently; submit monitoring review, return, confirm fresh-evidence gate, add evidence, approve, start material-change cycle, reassess, approve changed cycle, start renewal and read prior evidence history. | Duplicate evidence, stale-tab reload, alternative risk factors and AI/nonstandard vendor assessment combinations in this browser journey. |
| Linked policy/document text | Create a typed risk target, select it in policy draft, create, view, load editor text, edit/save, submit, reviewer return, resubmit, publish locally, download exact approved text, create next draft without replacing the current published revision. | Evidence document type variants, multi-link permutations, additional permission and stale-state variants. File upload behavior is tested separately by attachment acceptance; this does not duplicate it. |

The baseline workbench inventory in `BROWSER-ACCEPTANCE.md` separately records
observed controls and role-view combinations. Do not count an observed control
as a passing stateful action. Some pending browser variants can have separate
HTTP/unit coverage; verify it explicitly and label it accordingly.
