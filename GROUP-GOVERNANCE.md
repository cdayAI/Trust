# Local group governance and scoped app summaries

This opt-in walkthrough governs visibility of synthetic application descriptions. It is not SSO, an employee directory, production IAM, SCIM, external app activation, or entitlement enforcement at a downstream system. It never creates a workspace account, grants a role, changes workspace or portal permissions, calls an application, exposes sign-in codes, or returns launch links. Do not enter real people, systems, or company records.

## Walkthrough

```sh
TRUST_ENABLE_LOCAL_IDENTITY_ADMIN=1 TRUST_ENABLE_LOCAL_GROUP_GOVERNANCE=1 npm run start:isolated
```

1. Read the generated **owner-only local access file** shown by the launcher. The feature is off unless explicitly enabled. The application does not show the file contents.
2. In the fictional `harbor` workspace, sign in as `sample-identity-admin`, open **Group governance**, and create `sample-privacy-ops`. Propose `sample-case-operator` as a member and **Sample Case Reference** as an app grant.
3. In a separate browser context, sign in as `sample-review` in `harbor`. Open **Group governance** and approve both pending proposals. Review the exact app summary shown before approval. One approval by itself is not sufficient.
4. In another browser context, sign in as `sample-case-operator` in `harbor` and open **Scoped applications**. Only the approved app summary appears. Signing into `orchard` does not inherit the `harbor` group. Apps not yet granted are not returned.
5. The identity administrator can revoke either relationship or permanently archive the group. Reload **Scoped applications**: the summary should disappear.

## Authority and scope

| Local role | Group actions |
| --- | --- |
| Identity administrator | Create/archive group, propose an eligible account or exact app, revoke a pending/approved relationship; no independent approvals, no scoped application view |
| Reviewer | Inspect workspace proposals and audit, approve/reject a proposal made by a distinct account; cannot manage groups, propose relationships, or claim group-derived privileges |
| Analyst or case operator | Read app summaries only when locally active and both the account membership and exact app grant are approved and unexpired in the same active group |
| Other roles, portal identities, signed-out browsers, and built-in demo | No group authorities or scoped app access |

Groups and grants are isolated to one workspace; each request requires a matching currently authenticated workspace. A group cannot change an existing role's program permissions or expose private program data. Revocation takes effect on the next request, but cannot retract a response already delivered. Membership and app approvals independently expire after 30 days. Disabling, re-enabling, or revoking a member's sessions increments their seat generation and invalidates earlier membership approvals. Changes to credential provisioning or seat role fail closed against the prior approval. Changing a preconfigured app's name or summary invalidates the old grant while that changed app definition is in use. Revoke old relationships or archive affected groups before withdrawing or reusing provisioning configuration; restoring an exact earlier definition can otherwise restore its still-unexpired approval.

For an embedding test harness, set the isolated config's `enableIdentityAdmin: true` and `groupApplications: [{workspace, applications: [{id, name, summary}]}]` using only synthetic content, with one distinct identity administrator and reviewer in each enabled workspace. The catalog is preconfigured, not expandable from proposal inputs. The built-in launcher generates disposable local accounts and workspace paths. Use stable test configuration plus a stable storage path when validating persistence across restarts. A storage restore rolls access settings back to the backup's state; verify or revoke grants as part of a restore. JSON mode assumes one server process. No corporate connector, launch URL, or notification is configured.

## Interfaces and verification

- `GET /api/group-governance?workspace=…`: isolated admin/reviewer board, including the last 40 audit actions. Catalog and complete eligible-seat lists are restricted to the dedicated administrator; a reviewer sees the current proposed summary and proposal target.
- `POST /api/group-governance?workspace=…`: same-origin JSON, exact fields, strict role and workspace checks, and optimistic board revision. Changes and audit events persist atomically. Format: `{operation, group, expectedRevision}` for create/archive; additionally `target` for proposal; additionally `kind` (`member` or `app`) for approve/reject/revoke. Nothing runs in connected applications.
- `GET /api/scoped-applications?workspace=…`: approved summaries only, with `{id, name, summary}` and no account/group roster, authority data, raw state, launch URL, or any per-app mutation.

`node --test test/group-governance.test.js` runs the real HTTP checks for approval, isolation, least privilege, expiry, revocation, and JSON/SQLite persistence. Run with `RUN_BROWSER_SMOKE=1` and the existing Playwright/Chromium setup for the real three-account walkthrough.
