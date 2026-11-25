# Fictional requester result delivery

The local SQLite release enables the synthetic exercise in its two fixture
workspaces. Other deployments stay status-only unless explicitly provisioned
for this local feature. No actual records, entered text, attached documents,
contact details, passwords, or third-party connectors are accepted. Nothing is
sent by email or to anyone outside the loopback exercise.

Only a new portal **access** request pinned to the original synthetic code can
receive a result. An analyst must complete simulated identity verification and
mock fulfillment through the existing separate roles. Unverified closures,
other request types, manually opened cases, and legacy intakes without the
original binding are not eligible.

1. In **Privacy rights**, the analyst opens **Fictional requester result**,
   selects one of the fixed projections, and saves the draft. The preview shows
   exactly the allowlisted categories/counts that could be shared.
2. The analyst submits the exact result. The independent reviewer can return
   it or approve the exact version/digest. A returned work item requires a new
   version. Drafts, prior versions and reviewer actions are never served to the
   requester.
3. The same approving reviewer must explicitly confirm and release that
   approved version. Finishing the case or approving a draft does not release
   a result. Release is immutable.
4. The requester rechecks status with the original synthetic code and presses
   **View approved fictional result**. The output contains a fixed title and
   fixed example labels/counts only. It contains no case ID, intake answers,
   note, code fingerprint, reviewer name, raw fields or internal decision.
   Invalid/expired codes use the same generic response; any active code
   resolves only its own case. Reprovisioning the grant with a different code
   does not inherit release access.

The source case's fulfillment and intake records are not modified by release.
Workspace audit includes the release action and case/revision IDs. The role
presentation and browser do not offer real access-request fulfillment or
establish legal compliance.
