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

Current baseline: synthetic local workflows, local account isolation, optional
local transactional SQLite with tested migration and recovery, mock handoff,
and no live deployment. Production storage, encryption, and recovery
objectives remain outstanding. The design prototype uses
public identity cues, not an official corporate brand kit.

## Evidence from the local release

- **Data and recovery:** The opt-in SQLite backend has restart, concurrent
  command, backup integrity, isolated restore, and offline migration rehearsal
  tests, including read-only reconciliation of a restored synthetic import.
  Real platform mappings, managed encrypted backups, and an agreed
  recovery objective are still separate.
- **Authorization:** Local workspace isolation, role denials, account
  revocation, group grants, and exact-edition document grants are covered.
  Grants do not silently carry across document versions. OpenID Connect
  is exercised against a local identity fixture; company tenant federation
  and broad record/field-level policy still require validation.
- **Documents:** Real Chromium covers multi-select, drag-and-drop,
  all-or-nothing validation, and byte-exact downloads for supported formats.
  An opt-in quarantine blocks pending or rejected bytes and requires a
  separate reviewer before release. Structural validation and manual review
  are not malware scanning or a production evidence retention policy.
- **Workflows:** Scoped assessments, rights, incidents, audits, processing,
  training, disclosures, and more have independent review and role checks.
  The local operator jobs implement a narrow authorized and audited subset.
  No external transmission or real corporate decisions are simulated as real.
- **Operator experience:** The role-specific Home links to scoped live queues and
  operational views. Case operators see their assigned work only.
- **Verification:** [Browser acceptance](BROWSER-ACCEPTANCE.md) distinguishes
  controls that were exercised from controls merely observed. Hosted CI,
  additional browser engines/devices, screen readers, and all populated/error
  variants need their own evidence.

Use [Local release](LOCAL-RELEASE.md) to build a runnable source archive and
[Operations](OPERATIONS.md) to exercise startup, probes, and recovery privately.
