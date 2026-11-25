# Isolated workbench access policy

This policy applies only to the loopback **local isolated** mode with synthetic accounts. The regular demo intentionally retains its separate role selector; never deploy either as production authentication.

| Workspace role | Authorized scope |
| --- | --- |
| Analyst | Ordinary workbench program views, intake and applicable work steps, scoped program/queue reports, and project audit history. Cannot export the complete workspace audit or publish workflow definitions. |
| Reviewer | Ordinary workbench program views and independent review steps, plus complete workspace and standalone workflow audit. Cannot override program ownership or independence rules. |
| Publisher | Workflow studio, definitions and definition publication history. No workspace case/record data, workflow instance fields, transitions, or raw audit exports. Isolated workflow definitions cannot require the publisher to execute a transition. |
| Case operator | Assigned privacy-rights cases and published governance documents allowed by that program's policy. The same case scope applies to mutation responses. Unassigned case IDs and unavailable document editions are not revealed. No bulk audit, administration, or cross-program export. |

An allowlisted method and API path must match before a signed-in workspace runtime is opened. Workspace selection comes from the session and must match the supplied context. Program handlers still check record ownership, stages, and independent approval. Unknown methods and routes are denied. Add both an exact route policy and positive/negative authorization tests when you introduce an operator endpoint. Requester, employee, and local visitor routes have separate narrow validation and grants and never inherit an operator role.

`/api/state` no longer returns a whole workspace snapshot in isolated mode. It returns only the assessment shell's data, plus project-specific events when the account may view assessments. Ordinary per-program access and workspace-wide audit are separate permissions.

An isolated account can declare `disabled: true` or an optional `validUntil` epoch millisecond. Expiration is checked at sign-in and on session use; session switching can't extend the account's validity. An account can hold at most eight local sessions. Configuration is owned by the operator provisioning this synthetic server, not by HTTP clients. Disabled/removed or changed accounts need a restart to reload configuration, and a restart invalidates every in-process session. No external IAM, shared-session service, claim of regulatory compliance, centralized revocation, or production transport is supplied.

Verify the role matrix and expiry behavior with `node --test test/access-policy.test.js`. With the documented browser tooling enabled, the same file verifies that the browser's views and audit actions match the server-side role policy.
