# Current prototype scope

This table describes the standalone local prototype, not production readiness or parity with another product.

| Scope entry | Standalone state |
| --- | --- |
| Data mapping automation | Partial: typed system/dataset/activity links, validated directed lineage, archival and export tested by local HTTP. Includes reviewed import of bundled schema fixtures; no live scans or browser verification. |
| External research | Not built; external service, access not assumed. |
| Incident management | Partial: local standard/elevated investigations, fictional evidence references, independent simulated notice decisions, re-investigation and audited closure tested by HTTP. No jurisdiction engine, actual evidence storage, notice delivery, or browser verification. |
| PIA/DPIA automation | Partial synthetic vendor review through pinned workflow definitions and independent review; API integration tested. Synthetic pinned questionnaires, conditional validation, explicit route reasons and distinct standard/enhanced/AI workflow identities tested by local HTTP. No configurable publisher, production rule configuration or browser verification. |
| Privacy notice management | Partial: local draft, independent review and immutable publication per scope/channel tested by HTTP. No localization, scheduled or external publication, or browser verification. |
| Privacy rights automation | Partial: separate case intake, configured synthetic UTC due dates, owner assignment, gated simulated identity/fulfillment and exported action history tested by HTTP. No genuine identity evidence, external delivery, statutory rules, or browser verification. |
| Third-party due diligence | Partial: vendor-linked due diligence requires approved assessment IDs and fictional evidence, with independent review. No external screening, configurable publisher, uploaded evidence or browser verification. |
| Third-party risk exchange | Not built; external exchange, access not assumed. |
| Third-party risk management | Partial: reproducible synthetic vendor tier, reviewed monitoring cycles, tier-based renewal and fresh reassessments after a change tested by HTTP. No ongoing external monitoring or risk exchange. |
| Compliance automation | Partial: local recorded test outcomes, fictional IDs and independent evidence decisions verified by HTTP. It does not actually run control tests or certify compliance. |
| Enterprise policy management | Partial: versioned local policy drafting, independent local publication, immutable superseded revisions and audit. Synthetic employee attestation is supported separately; no enterprise distribution. |
| IT and security risk management | Partial: local scored risks, independently reviewed links and control test evidence inform residual scores. No integrations or automated evidence collection. |
| Data catalog | Partial typed local inventory with provenance, usage references and reviewed schema-only synthetic imports; no production scanning, classification, glossary, or enterprise catalog parity. |
| Data discovery | Partial: schema-only discovery over bundled fictional fixtures, rule-based label hints, non-mutating preview and reviewed inventory import. No real scans, value inspection, data sources or production classification. |
| Campaigns | Not built. |
| Dashboards | Partial: local metrics and cross-workflow owner/reviewer work queue with filters. No configurable dashboards or production feature completeness. |
| Documents | Partial: role-scoped original fictional text, typed case/control links, independent review, version integrity, audited read/download. Includes bounded synthetic text attachments with audited forced downloads. No enterprise identity integration, general document ingestion, or durable file object storage. |
| Employee portal | Partial: separate provisioned synthetic access, version-pinned published policy assignment, explicit idempotent acknowledgment and locally signed receipt. No directory, onboarding, training or real identity integration. |
| Global data management | Partial: typed independently reviewed dictionary versions, current-version assignment, exact inventory pins, consumer impact and retirement/archival guards verified over local HTTP. No enterprise reference-data sync, administrator customization or browser verification. |
| Integrations | Registry and one mock retry only; no real transport, credentials or delivery. |
| Reports | Role-scoped workflow and audit reporting supports filters, grouping, JSON and CSV. No scheduled or external delivery. |
| Risks | Partial: explicit and auditable inherent/residual scores and per-control eligibility in a standalone view. No multi-program reporting, automated imports or browser verification. |
| Self-service portal | Partial: isolated, provisioned synthetic requester codes, one case per code in the actual rights workflow, scoped receipt and coarse status. No open public intake, communications, identity proof, uploads, real disclosures or browser verification. |
| Trust center | Partial: versioned bundled synthetic cards, independent review, explicit local publication and withdrawal, and a separate visitor projection. No public deployment, authentication for real visitors, evidence exchange, customer self-service, or browser verification. |
| Users and groups | Partial: synthetic local sessions authenticate accounts, select verified workspace memberships and segregate records and exports. Dedicated synthetic identity-administration lifecycle and least-privilege route policies; no corporate identity provider or enterprise groups. |
| Platform home and tasks | Partial: shared read-only queue derived from seven actual workflow families, owner/workflow/timing filters and record navigation. Includes isolated My Work for assigned staff seats; no external notifications. |
| Audit management | Partial: scoped synthetic audit plans, versioned assessed evidence, structured findings, independent finalization and immutable report export. No external audit or actual assurance. |
| Helpline and ethics cases | Partial: scoped synthetic case intake, investigation, versioned findings, independent closure and redacted export. No real helpline. |
| Maturity and planning | Partial: scoped synthetic maturity plans, versioned evidence-linked baselines and targets, deterministic roadmap and independent sign-off. |
| Policy and notice management offering | Shared local policy and notice pieces exist; no verified parity with the separate offering. |
| Program benchmarking | not built. |
| Retention schedules | partial local versioned schedules, UTC due-date previews, reviewer release of holds and audited dry-run disposition tested by HTTP. No live records, deletion, schedules running automatically, or browser verification. |
| Training | Partial: approved synthetic lessons pinned to published policies, scoped assignments, bounded quiz attempts and completion receipts. No live LMS integration. |

## Implemented shared behavior: versioned workflow execution

A separate loopback API and local Workflow studio implement immutable published definition versions, per-instance version binding, explicit transition names, mandatory expected revision, role separation, and accepted/refused events. Tests use independent synthetic definitions rather than copying source configuration. This dimension is reusable for multiple app families; it does not establish their configuration or runtime parity.

Main vendor assessments now use an embedded assessment instance of this engine. The other generic modules have not been migrated to this engine. Default access remains an explicit loopback demo. The separate isolated local mode verifies expiring sessions and membership before selecting per-workspace files. Neither mode is a production deployment boundary; default storage is single-process local JSON, with opt-in transactional SQLite and tested local backup and restore. Workflow audit is separate from the existing register audit.
