# Restricted additional document reviewer

The default Trust workspace still rejects multiple unqualified seats for the same role. Broad reviewer permissions currently include report and audit export, oversight boards, and role-scoped decisions. My Work and portions of the underlying workflows still attribute assignment to a role. Simply admitting a second unrestricted reviewer would grant all of that authority.

This opt-in local synthetic scenario permits exactly one extra named reviewer seat for text-only governance-policy editions. The secondary account carries the existing reviewer role **plus a mandatory restricted profile**, with an authorization allowlist intersected with the ordinary role. It cannot use the general queue, exports, other workspaces without an explicitly provisioned membership, other program modules, case rights, jobs, audit, or portal grants. Its review inventory includes only the exact submissions assigned to it. The normal reviewer remains available to review other submissions.

## Run the scenario

```sh
TRUST_ENABLE_LOCAL_DOCUMENT_REVIEW_SEAT=1 npm run start:isolated
```

Using only the generated private fixture accounts, sign in as intake analyst in Harbor. Draft a fictional policy with no attachments or record links, then submit. Choose **Assign a named reviewer → Assign document review**. Sign in from another browser context as `sample-document-reviewer`; only the assigned current edition appears. The secondary reviewer can read text and return or publish that edition. The primary reviewer sees the assignment but cannot decide it while it is assigned. The analyst can clear the assignment and return the review to the primary seat.

Embedding tests configure `documentReviewSeats: [{workspace, account}]` and explicitly provision the additional `sample-` account with the `reviewer` membership alongside one separate `sample-` primary reviewer and the analyst. This provisioning is intentionally rejected when corporate/OIDC sign-in is configured. With no additional profile configured, the previous one-seat-per-role rules still apply. Workspace membership continues to be statically provisioned.

## Boundary

- Assignment is tied to the current immutable submitted edition, the named account, and that account's seat generation and provisioning. A returned/resubmitted edition requires a new assignment. Assigning or publishing an edition as one of its own contributors is denied.
- Identity administration can revoke the second account's session or disable that workspace membership; future requests fail immediately. Re-authenticating with a new session generation does not revive an old assignment. Stale assignments continue to prevent decisions by the primary reviewer until the analyst explicitly clears or freshly assigns them. There is no automatic fallback or delegation.
- The limited HTTP profile exposes only safe session state, assigned review metadata, and allowed text/decision requests. The list has no underlying catalog or raw audit. It does not add attachment, export, or download authority. Previously delivered text cannot be revoked.
- This is not general multi-seat staffing. Extending it across the platform needs explicit account assignments and independent-review checks for shared queues and oversight modules, reviewer reassignment and lock/version contracts for every transition, plus a dedicated corporate lifecycle design.
- Run `node --test test/document-review-seats.test.js` for scope, independent review, fail-closed revocation and compatibility checks; enable `RUN_BROWSER_SMOKE=1` with the existing Chromium setup for the UI.
