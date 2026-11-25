# Isolated portals, documents, and data-governance browser acceptance

These Chromium journeys use generated synthetic identities, a fresh temporary
store for each test, and localhost only. Where a prerequisite is not the
subject of a browser assertion, the test creates it through the authenticated
localhost HTTP API; these setup calls are not counted as UI coverage. The
browser diagnostics report control occurrences activated and checked, plus
explicit availability checks that did not activate the control. Repeated
occurrences (sign-in, repeated navigation, resubmission) are not distinct
controls. A control opening a pane is not evidence that every action in it
works. The tests also assert no uncaught page errors or external requests.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/browser-portal-controls.test.js
```

| Surface | Browser evidence | Not covered by this pass |
| --- | --- | --- |
| Requester | Enter invalid and valid access codes, check the no-request state, select request type and submit two isolated fictional requests, refresh through received/in progress/completed and closed without disclosure, clear status and refocus input, confirm independent receipts and no operator-only text, reopen and reload. | The internal review/fulfillment controls for these fixture cases are API-driven. No employment applicant/candidate UI was found in this snapshot; the privacy requester is not a substitute. No real identity verification, external delivery, or browser expiry and rate-limit checks here. |
| Employee attestations | Analyst selects employee and exact published edition, assigns, and opens the employee portal. Unassigned account sees an empty screen. Assigned code reveals the exact edition, unchecked form cannot acknowledge, checked form records a durable receipt seen on reopening by employee and in the analyst history. Clear refocuses the input and hides the result. | Multiple simultaneous editions, expired grant and error routes in browser; version/receipt isolation has separate HTTP tests. |
| Training learner | Compare empty grant and assigned grant in the same browser, open assigned course, expand exact pinned policy, see start control, then clear and confirm the course stays inaccessible after returning to the unassigned grant. | This journey does not repeat answering, resetting, completion or receipt download covered by the separate training journey. |
| Trust center | Choose canned copy, draft, submit, independently return with an internal note, draft and submit v2, approve without publishing, explicitly publish v2, open/read version history, draft/approve v3 without disturbing active v2, replace v2 only on explicit publication, then withdraw v3 without restoring v2. Both preview contexts see exactly one active edition during replacement and nothing after withdrawal. | Other topic/copy permutations and visitor transport failure in Chromium. |
| Map and lineage | Create typed dataset, exercise stale form rejection and Reload map, rename without changing identity, check type-filtered endpoint choices, add directed link, inspect downstream lineage, archive link and observe updated lineage, archive disconnected record, inspect archive as reviewer and parse actual JSON download. | Other link kinds, upstream/multi-hop browser paths, cycle refusal, discovery conflict and no-change branches. |
| Governed dictionary | Choose bundled schema, preview and apply it. Create typed term, submit and approve, pin approved v1 to an eligible dataset, draft v2 and return it with internal history, revise/approve v3 without re-pinning existing consumer, verify inventory still shows v1, detach explicitly, retire and parse actual JSON download. | Other term kinds/consumer types and stale conflict variants in browser; map/term conflict paths have HTTP coverage. |
| Documents and linked evidence | Create evidence with an actual typed rights-case link. Select/upload differing fictional TXT and CSV fixtures in two successive revisions; verify review/publish makes each revision read-only, case owner cannot see unpublished or another case's evidence, and approved current vs superseded versions expose their own text and byte-exact attachment only. | The format allowlist and real chooser round-trip for all types stay in `test/governance-document-attachments.test.js`; this is a revision/scope test, not a second format matrix. Multi-link permutations, transfer while open, attachment failure modes, and additional viewport/browser combinations are not tested here. |

See `BROWSER-ACCEPTANCE.md` and `WORKFLOW-ACTIONS-ACCEPTANCE.md` for
the other control inventory and stateful runs. No live deployment or real
company data was used.
