# Coverage proof: privacy workflows

This is an evidence ledger, not an assertion of product parity. A label, form, enum or example record is not evidence that the named operational capability is implemented. The evidence below is limited to the standalone synthetic prototype.

## Evidence levels

- **Verified behavior**: An automated acceptance test or repeatable end-to-end run demonstrates the exact behavior and a denied/invalid path, where applicable.
- **Register only**: A synthetic record can be created and moved through a lifecycle, but the work named by the module is not executed.
- **Unverified**: There is no approved source trace or executable proof for the capability. Do not promote it based on a similar industry term.

## Current baseline

| Area | Verified behavior / register boundary | Not proved |
| --- | --- | --- |
| Project/vendor assessments | API tests verify seeded and new project/vendor intake, conditional AI review, required answers, distinct reviewer, return/resubmit, and all-approvals gate. The actual assessment API also verifies version pinning, a stale/concurrent decision conflict, audit correlation and restart. | Exact questionnaire, branching and duties from any separately maintained specification. |
| Mock integration handoff | API tests verify eligible first failure, same approved snapshot and IDs across retry, synthetic receipt, duplicate rejection, and both attempt outcomes in export. | Real integration payload, integration or delivery. |
| Audit | API tests verify actor/sequence/timestamp consistency, review decision, handoff outcomes, download and restart persistence. | Immutable evidence storage, production audit controls, cross-tenant scope, or retention. |
| Inventory / processing | Register only: catalog dataset/system/category and document processing purpose, parties, and retention references. | Automated discovery, verified lineage, relationship integrity, or generated authoritative records. |
| Rights | Register only: synthetic case tracking with request type, owner, due date and scope. | Identity verification, records search, access/erase fulfillment, response delivery, or validated deadline computation. |
| Incidents | Register only: synthetic severity, owner, scope and containment. | Reportability decision, deadlines/escalations, notification or remediation signals. |
| Third parties / risks / controls | Registers only beyond the assessed workflow: references, risk notes, control test evidence notes and stages. | Transactional joins to assessments, evidence collection, control execution, mitigation verification or automated monitoring. |
| Retention / policies | Registers only: note schedules, dispositions, review states and policy identifiers. | Published version history, enforceable retention/holds, actual disposal or policy distribution. |
| Administration / integrations | Registers only: propose configuration and record mock/offline integration metadata. | Authorization changes, access management, live service connection or credential use. |
| Browser journey | HTTP entry and served assets verified; browser test file is runnable with Playwright and Chromium. | Actual rendering and interactive smoke until a working browser runs the test. |

## Proof checklist for specification work

For each approved requirement, record the short requirement ID, implementation path, acceptance test ID and observed pass/fail. Mark blocked when no approved requirement source or runtime evidence exists.

- [ ] **Declared transition:** From the specified start state, the valid action reaches the expected state. Confirm undeclared actions and out-of-order transitions are rejected; callers cannot directly set state. Check the terminal state declines further advances.
- [ ] **Concurrency:** Two legitimate writes carrying the same expected revision yield one success and one stale conflict. Verify the losing request does not change persisted state or emit a success event. Repeat with a duplicated transition.
- [ ] **Independent review:** The originator/editor cannot approve their own submitted revision. Verify a distinct reviewer can approve exactly that revision, and edits after submission require a new review.
- [ ] **Published revision:** Approval/publish has a durable revision ID and immutable content snapshot. Editing opens or changes a draft only; public/approved readers keep seeing the old snapshot until a new revision is deliberately published. Reopen persisted data and compare both snapshots and relevant audit events.
- [ ] **Capability outcome:** Where a requirement describes performing work, assert the output or side effect explicitly rather than relying on status text. Use approved synthetic adapters when external systems must not be contacted.
- [ ] **Audit and recoverability:** Verify actor, action, state before/after, record/revision IDs, and correlation or reason where applicable. Confirm successful, failed, and retried effects are distinguishable, survive restart, and do not duplicate.
