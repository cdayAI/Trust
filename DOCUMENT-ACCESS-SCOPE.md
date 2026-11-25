# Record-level access to governance documents

This is a local synthetic rollout for delegated **case operators** in selected isolated workspaces. It gates individual published revisions of policies and evidence, rather than granting an entire document collection. It is not a global record- or field-permission system. The existing analyst/reviewer authoring and publication authorities, requester and employee portal grants, case workflows, and synthetic demo are unchanged.

## Run the walkthrough

```sh
TRUST_ENABLE_LOCAL_IDENTITY_ADMIN=1 TRUST_ENABLE_LOCAL_RECORD_SCOPE=1 npm run start:isolated
```

Sign in to the fictional Harbor workspace using only the generated owner-only local access file. Use separate browser profiles or private windows for each role:

1. An analyst creates and submits a synthetic policy. A reviewer publishes it. A case operator opens **Policies and documents** and does not see the published record.
2. The reviewer opens **Document access** and requests access to the exact published edition for the case operator. Choose **Text only** or **Text and attachments** and record a reason.
3. The identity administrator opens **Document access**, verifies the target account and the exact document and edition IDs, and approves. This role cannot read document titles, content, attachment metadata, or attached files.
4. The case operator reopens **Policies and documents**. Only that edition is visible and its text can be read or downloaded. Attachment names and downloads are absent with a text-only grant, even if the operator has the attachment ID. Later editions are not covered.
5. The identity administrator can revoke access immediately. A new list, text request, or attachment download then denies access. Previously handed-out bytes cannot be recalled.

For an embedding test harness, enable `enableIdentityAdmin: true` and supply `documentScopeWorkspaces: ['example-id']` with separate provisioned reviewer, case operator and identity-admin accounts in each workspace. Without valid configuration and distinct seats, a configured rollout fails startup. Switching a workspace into scoped mode creates a durable marker before serving requests. Removing the opt-in from a previously scoped workspace disables all delegated document reads rather than restoring legacy broad access. Before any rollout, workspaces that were never scoped and the demo behave as previously. Stable local config and storage paths are required for restart testing. Restoring an older backup can undo grants or the marker; keep the scope configuration enabled when restoring and reconcile existing grants before reopening access.

## Enforcement and tests

- A scoped case operator's document listing and direct read, text-download, and attachment-download routes consult the same exact account-and-edition policy on the storage snapshot. The mutation path checks current session generation again within the SQLite transaction before exposing content or committing successful read audit. Unauthorized and unknown records produce the same not-found response. Scoped case operators cannot reach workspace/reporting exports, policy authoring, or raw state.
- Reviewer proposes and identity administrator approves, rejects or revokes using versioned decisions. Approvals expire after 30 days. Decisions, target IDs, scope and reason append to the local audit automatically; history is not editable through the UI. This is not an external immutable audit store. The administrator's projection includes only necessary IDs, grant metadata and enum reasons.
- Grant coverage is edition-specific and bound to exact text and attachment fingerprints, provisioned seat and membership generation. Linked evidence also requires the existing linked-case ownership policy. Reassigning a linked rights case and later assigning it back does not revive the old grant. An identity disable/re-enable, session revocation or credential change invalidates the member binding. No new grants are inferred from a workspace role, group, or different workspace.
- Test with `node --test test/document-scope.test.js`. Set `RUN_BROWSER_SMOKE=1` and use the existing Playwright/Chromium setup to exercise the reviewer → identity admin → operator workflow.
