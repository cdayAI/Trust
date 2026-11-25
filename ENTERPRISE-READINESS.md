# Enterprise readiness gates

This is a standalone synthetic prototype. Do not connect it to live systems or
describe it as ready for production based on local tests or design quality.

| Gate | Required release evidence |
| --- | --- |
| Identity and permissions | Approved SSO architecture; entitlement mapping and deprovisioning; server-enforced least privilege; tested workspace and role boundaries and production session configuration. |
| Durable storage | Transactional datastore, migration and rollback rehearsal, encrypted backup and successful restore with agreed recovery objectives. |
| Audit and evidence | Approval and change traceability, independently verified audit coverage, retention and tamper-evident export, redaction and access rules for evidence. |
| Operational resilience | Service health, actionable alerts, support owners and incident/runbooks; monitored load and recovery tests with agreed thresholds. |
| Accessibility and quality | Keyboard-only and screen-reader journeys, automated accessibility checks, mobile and desktop coverage, reduced-motion and reduced-transparency checks, repeatable browser and API runs. |
| Workflow acceptance | Verified enterprise requirements and acceptance evidence for the scoped workflows, permission failures, rework, expiration and escalation. Tracking and consent management are not in scope. |
| Integrations and rollout | Written approval for authorized connectors and approved design assets, isolated QA in the receiving environment, staged rollout, rollback plan and sign-off from accountable owners. |

Current baseline: an isolated, synthetic local workbench with transactional
SQLite, a receiving rehearsal and restore checks, mock handoff, and no live
deployment. The design uses public identity cues, not an official corporate
brand kit. A successful local rehearsal is evidence for a specific workflow,
not approval to use corporate data, infrastructure, or identity accounts.

## Evidence from the local release

- **Data and recovery:** The SQLite backend has restart, concurrent command,
  backup integrity, and isolated restore checks. The [receiving rehearsal](MIGRATION-REHEARSAL.md)
  revalidates an untouched synthetic import and opens an editable scratch copy
  without changing the source. [Optional encrypted offline archives](DURABLE-STORAGE.md)
  use a private POSIX key file. They do not encrypt the restored database or
  replace managed backup, key rotation, and recovery objectives.
- **Authorization:** Local workspace isolation, role denials, account
  revocation, group grants, and exact-edition document grants are covered.
  Grants do not silently carry across document versions. An optional
  [restricted reviewer seat](DOCUMENT-REVIEW-SEATS.md) can review only assigned
  text-only editions, not manage other queues. OpenID Connect is exercised
  against a local identity fixture. Corporate federation, multi-seat staffing,
  and broad record- and field-level policy still require validation.
- **Documents:** Real Chromium covers multi-select, drag-and-drop,
  all-or-nothing validation, and byte-exact downloads for supported formats.
  An opt-in quarantine blocks pending or rejected bytes and requires a
  separate reviewer before release. Structural validation and manual review
  are not malware scanning or a production evidence retention policy.
- **Workflows:** Scoped assessments, rights, incidents, audits, processing,
  training and disclosures have independent review and role checks. Staff can
  rehearse [redacted fictional retrieval](RIGHTS-RETRIEVAL.md); it neither
  retrieves real records nor bypasses requester release. The opt-in local
  [report worker](REPORTING.md) processes approved named schedules without
  outbound delivery; manual approvals remain manual. [Offline audit checks](AUDIT-VERIFICATION.md)
  verify bytes and references, not signer identity or authenticity.
- **Operator experience:** The role-specific Home links to scoped live queues and
  operational views. Case operators see their assigned work only.
- **Verification:** [Browser acceptance](BROWSER-ACCEPTANCE.md) and the
  [isolated navigation audit](BROWSER-ISOLATED-RELEASE-ACCEPTANCE.md) distinguish
  controls exercised from controls merely observed. Linux CI runs Chromium and
  synthetic HTTPS sign-in; Windows CI checks scripted PowerShell/SQLite startup.
  These are separate checks. Interactive Windows use, additional browsers and
  devices, screen readers, and untested data/error states need their own evidence.

## What to decide before a private pilot

1. Name the approved private host, pilot audience, owner and disposable dataset.
   Keep sample data isolated; do not reuse a work identity or secret.
2. Confirm the permitted workflows, their owners, the cases that must be
   denied, and who can independently approve the pilot. Record unresolved
   workflow and migration differences instead of inferring parity.
3. Select the required sign-in, backup, restore, monitoring and rollback
   checks for that environment. Record actual results and the tested build.
4. Authorize any additional connector, real data or distribution separately.
   A local package or a green CI job is not a running pilot.

Use [Local release](LOCAL-RELEASE.md) to build a runnable source archive and
[Operations](OPERATIONS.md) to exercise startup, probes, and recovery privately.
