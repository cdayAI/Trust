# Synthetic workspace identity administration

This feature is for the **local isolated** mode and pre-provisioned fictional
accounts. It does not provision users, manage credentials, change roles, or
connect to corporate SSO.

## Try it locally

```sh
TRUST_ENABLE_LOCAL_IDENTITY_ADMIN=1 npm run start:isolated
```

Use the existing owner-only test-access file printed by the launcher to sign in
as `sample-identity-admin`. No identity administration seat is provisioned
without this opt-in. A custom integration must set `enableIdentityAdmin: true`
and explicitly provision one `identity-admin` seat in each desired workspace.
One synthetic account may have seats in multiple workspaces, but actions and
history are always scoped to its active workspace. The administrator seat
itself cannot be edited in the interface; its lifecycle is controlled by local
provisioning. The role cannot perform ordinary program tasks, view or export
those records, publish workflows, or read general audit exports.

## What the administrator can do

- Read the synthetic account roster and recent access activity for the selected
  workspace. The screen does not display sign-in codes, hashes, session tokens,
  or additional workspace memberships.
- Disable an existing membership. From then on the account cannot use an
  existing session, sign in, or switch into that workspace.
- Re-enable a locally disabled membership. This does not restore older
  sessions, create a membership, or override an expired or disabled
  configuration.
- Revoke the current workspace's sessions without disabling the membership.
  Fresh sign-in is allowed. Other workspace memberships and sessions are
  unaffected.

The browser requires an explicit confirmation and an enumerated reason.
The server checks the current membership revision, the active administrative
session and scope, and the requested transition. Each successful change stores
the new membership revision and its audit event together in the workspace's
existing store. The administrative page lists the most recent 50 changes; a
reviewer can use the separate existing workspace audit export to inspect the
full history. Rejected changes do not alter membership or its change history.

Authorization rechecks the durable membership revision for sessions on every
use. This does not cancel an operation already in progress or revoke separate
requester/employee portal grants. The SQLite recovery flow preserves membership
state and audit, but a backup restored to an earlier point also restores the
access policy *at that point*; reconcile it against desired provisioning before
serving traffic. Sessions are in process and invalidated on restart. The
launcher creates fresh random local test accounts at startup; to retain
workspace state across launches, supply `TRUST_SQLITE_FILE`. The JSON backend
is a single-process local fixture, not a shared identity store.

```sh
node --test test/identity-admin.test.js
```

With Chromium enabled as described in [browser acceptance](BROWSER-ACCEPTANCE.md),
the test file also verifies sign-in, explicit UI confirmation, and the resulting
access history. These checks do not establish a corporate IAM or deployment
readiness gate.
