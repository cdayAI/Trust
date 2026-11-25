# Synthetic directory reconciliation

This opt-in local workflow allows an identity administrator to prepare an exact batch of suspensions for already provisioned `sample-` accounts. A separate workspace reviewer must approve the exact plan. The approval updates the target memberships, revokes their current sessions, and records the before/after evidence in one workspace's storage transaction. It does not create accounts, change their roles, delete them, or apply a suspension to a different workspace. No external calls or communications occur.

## Walkthrough

```sh
TRUST_ENABLE_LOCAL_IDENTITY_ADMIN=1 TRUST_ENABLE_LOCAL_DIRECTORY_LIFECYCLE=1 npm run start:isolated
```

1. Using the generated private local access file, sign in as `sample-identity-admin` in Harbor. In **Directory reconciliation**, select active synthetic accounts such as `sample-intake` and `sample-case-operator`. Prepare a plan, inspect the exact before/after generations and digest, and submit it.
2. In a separate browser context sign in as `sample-review` in Harbor. Check the exact plan and approve the batch. Appending a new authority or list entry after drafting is impossible; cancel/reject and create a new plan to correct it.
3. Existing targeted Harbor sessions fail their next authorized request and cannot sign in again to Harbor. The same accounts' Orchard memberships are independent. The separately provisioned Orchard reviewer and administrator can prepare and approve a different plan there.
4. The existing individual identity administration workflow can explicitly re-enable a membership when appropriate. That does not restore previous cookies, nor does cancelling or editing a plan silently undo an approved suspension.

Embedding test harnesses enable `enableIdentityAdmin: true` and `directoryLifecycleWorkspaces: ['workspace-id']` on local isolated server setup. Each enrolled workspace has distinct active administrator and reviewer seats and uses only `sample-` account IDs. Those two authority roles are not eligible targets. This feature is not available in the demo or corporate/OIDC modes.

## Guarantees and limits

- Each immutable plan has a workspace-local version, proposer, selected accounts, an enumerated reason, exact before/after membership generations, and SHA-256 digest over the canonical plan. It expires for approval after seven days. Membership or credential provisioning changes, or new session-generation changes for any target, invalidate approval of the entire plan; no partial application occurs.
- The approving account must be distinct even after a role reconfiguration. Plan decisions and each exact applied suspension append attributable records to the local audit. Both plan and roster mutations persist in the same workbench transaction. JSON deployments still assume a single writer; SQLite provides the storage transaction. This is not an externally signed or independently retained audit log.
- Removing the feature opt-in does not undo prior suspensions. Authorization is enforced on each new request, not retroactively on bytes already delivered or work already authorized before approval.
- There is no actual SCIM endpoint, automatic directory ingestion, just-in-time account provisioning, external reconciliation or HR webhook, corporate IdP role synchronization, remote session revocation, or atomic cross-workspace update. The local prototype cannot stand in for a production directory service.
- `node --test test/directory-lifecycle.test.js` exercises scoped HTTP authorization, digest integrity, two-workspace independence, all-or-nothing stale-plan refusal, and persistence. Set `RUN_BROWSER_SMOKE=1` with the usual Chromium installation for the three-browser-role walkthrough.
