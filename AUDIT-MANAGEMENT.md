# Synthetic audit management

The **Audit management** tab runs a control-scoped operational audit. It is distinct from the workspace activity log. This slice uses only synthetic control names, evidence references, and observations. It does not upload files, contact outside services, or perform control tests.

1. Sign into the local workspace as its analyst (or use the analyst in demo mode). In **Risk and controls**, add one or more synthetic controls.
2. In **Audit management**, create a plan with a title, objective, scope and period, and one or more controls. The selected control IDs, names and objectives are snapshotted into the plan. Begin fieldwork.
3. Assess each scoped control using a synthetic reference such as `SYN-ACCESS-01`. An exception requires a severity and proposed corrective action. Revised assessments append to, rather than replace, earlier evidence. The audit cannot be submitted until every scoped control is assessed.
4. Sign in as the separate reviewer. Return the plan with a reason or finalize it with a rationale. If it is returned, the analyst can append revised assessments and submit again.
5. Download the immutable report JSON from the finalized plan. It contains the locked scope, selected evidence and findings, evidence and decision history, final revision, and separate SHA-256 field. The digest hashes the UTF-8 bytes of `JSON.stringify(report.result)` in persisted property order; it is a check value, not a signature or protection against direct file tampering.

Local isolated mode derives the actor and workspace from the existing sign-in session. Demo mode uses role switching and is not an authentication feature. The data directory remains single-process local persistence. This slice does not cover evidence uploads, retention guarantees, assignment/SLA tracking, regulatory frameworks, or external auditor access.

Run the isolated HTTP acceptance test with `node --test test/audit-management.test.js`.
