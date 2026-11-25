# Local case-account delegation for privacy rights

This opt-in rollout prevents a workspace role assignment from automatically granting access to individual privacy rights cases. The intake analyst delegates one synthetic case to one currently provisioned case-operator account for up to 30 days. It does not change analyst/reviewer duties, requester portal receipts, case identity verification, decision independence, or deadlines. It is not corporate SSO, account enrollment, a platform-wide field permission system, or production readiness evidence.

## Try it locally

```sh
TRUST_ENABLE_LOCAL_RIGHTS_CASE_SCOPE=1 npm run start:isolated
```

Use fictional Harbor or Orchard data and the launcher’s private generated access file. Sign in using separate browser contexts:

1. As intake analyst, open a synthetic case assigned to the case-operator role. The operator cannot list the case or see it in My work or the workspace dashboard.
2. As analyst, open **Account access** inside that case. Confirm the exact account and reason, then select **Delegate this case**. Case access is workspace-local and limited to this specific case.
3. The case operator can now see the case. If an independent reviewer has verified identity, the normal fulfillment controls apply. Delegation does not verify identity or send any data.
4. The analyst can revoke access through the same control. A fresh list, My work link, or write request can no longer use that case. Data that was previously displayed cannot be recalled.

Embedding harnesses can set `rightsCaseScopeWorkspaces: ['workspace-id']`. Each enrolled workspace requires separate provisioned analyst and case-operator seats. The current local provisioning model supports one account per role per workspace. Workspaces that have never enrolled and the built-in demo keep their prior behavior. Once enrolled, the mode is marked in workspace storage. If the scope configuration is later removed, all delegated case reads and actions in that workspace deny access instead of restoring role-wide visibility. Reconcile grants before restoring old backups, and keep the scope configured during restore. JSON mode assumes one writer.

## Coverage and limits

- Grant and revoke use the existing case revision and append attributable audit entries in the same completed transaction. The board is shown only to the analyst. Scope fingerprints are never included in the HTTP projection.
- The grant binds an exact case, workspace seat/account and credential provisioning, membership generation, and role-assignment epoch. Expiry, changing the seat, disabling or revoking its sessions, moving the case to another role, or moving it away and back invalidates the old delegation. An operator cannot grant access at all. A closed case cannot get a new delegation.
- The case list, direct state transitions, My work list and task tokens, and staff dashboard use the same case authorization. Unknown and unauthorized cases yield identical not-found responses for operator writes. Analyst/reviewer reports remain protected by their existing role policy.
- A case-bound evidence document also requires current delegation to all rights cases linked to that edition. When document scope is enabled, an independently approved document grant is additionally required. Renewing or reassigning a case delegation does not reactivate its old document grant. The scope does not add rights restrictions to unrelated policy documents.
- `node --test test/rights-case-scope.test.js` runs the real HTTP denial, positive action, revocation, dashboard/deep-link, cross-workspace, restart, and policy composition tests. Follow the browser-test setup with `RUN_BROWSER_SMOKE=1` to verify the real grant/read/revoke flow.
