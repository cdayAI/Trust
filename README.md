# MVW Trust

A work-in-progress privacy operations prototype with synthetic fixtures. It is not an official Marriott Vacations Worldwide service or a production release. Use fictional records only.

## Run

See the [install-free quickstart, local package, and verification guide](LOCAL-RELEASE.md).

Use Node.js 22.13 or newer. The demo and isolated launchers run without npm dependencies. See the [corporate sign-in guide](CORPORATE-SIGNIN.md) for the optional OIDC mode.

```sh
npm start
```

Open http://127.0.0.1:4173. The intake analyst and reviewer are **simulated local identities**, not authentication. Never expose this server publicly or use it for real records. The mock integration does not contact another service.

- **Assessments**: Add a project and vendors. Each vendor gets a privacy assessment; a vendor marked as using AI also gets an AI-risk assessment. Submit as analyst, decide as reviewer, and try the simulated handoff as analyst. The first eligible handoff fails on purpose; retry uses the same package.
- **Program modules**: Create records in separate registers and move them through module-specific stages. These workflows are prototypes, not implementations of statutory obligations or live integrations.
- **Reporting**: See synthetic project, vendor and assessment counts, pending reviews, failed handoffs, and per-module stage totals.
- **Export audit JSON**: Download the workspace's synthetic event history.

The app saves locally to `data/state.json`. Use a new `DATA_FILE` path to start fresh; use `PORT` to override 4173. The demo reads and writes a single process-local state file, not a production database.

## Run with synthetic workspace separation

```sh
npm run start:isolated
```

This launch creates two separate, empty workspaces in a private, fresh
temporary directory. The console prints the path to a local file containing
random synthetic account codes. Open the loopback address and enter an account,
one of its workspace IDs, and its generated code. Do not use real passwords or
records. When finished, stop the server and delete that run’s temporary directory.
A new launch does not resume that directory.

The server issues a short-lived session cookie and checks the active membership
on every data route, including exports and the workflow sandbox. The scope in the
request must match the session; it does not grant access. Changing workspaces
rotates the session and changes the effective role. Each workspace starts empty,
with separate files. The app uses server-derived roles rather than the demo
selector in this mode. A role may be assigned to only one test account per
workspace. This slice does not provide groups, row-level permission policies,
production credential management, TLS, multi-process storage, or protection
against software already running as the local user. Signed-in members can read
the ordinary shared workspace records; document and action-specific restrictions
remain in effect. All workbench data remains synthetic.

For local API tests, non-session endpoints require `?workspace=<active-id>`
and the issued cookie. Writes also require the exact loopback origin and JSON.
Sign-in is `POST /api/session/login` with `account`, `workspace`, and `code`;
the browser handles the resulting cookie. See `test/workspace-access.test.js`.

## Durable local mode

Set `TRUST_SQLITE_FILE` to use the optional transactional SQLite backend.
The [local synthetic operator API](OPERATOR-API.md) uses this backend in isolated
mode for durable jobs and independently reviewed rights-case reassignment.
See [backup, restore, and migration](DURABLE-STORAGE.md). The legacy JSON
backend remains available for local compatibility.
Use the [fictional migration rehearsal](MIGRATION-REHEARSAL.md) for a dry run,
confirmed isolated test import, and non-destructive rollback.

## Interface

The web workbench uses a Liquid Glass-inspired visual system for the
navigation, summary cards, and important controls, while keeping task forms
and tables on opaque surfaces. Reduced transparency and motion settings are
respected; the toolbar also offers **Solid surfaces**. The product mark and
horizon illustration are original prototype artwork. Color direction is
informed by the public [Marriott Vacations Worldwide corporate site](https://www.marriottvacationsworldwide.com/);
this is not an approved corporate brand kit.

See [enterprise readiness](ENTERPRISE-READINESS.md) for the outstanding gates and [local operations](OPERATIONS.md) for liveness, readiness, and recovery.

## Verify

```sh
npm test
```

The optional browser smoke requires Playwright and a working Chromium installation: `RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium npm test`. See ACCEPTANCE.md for the first workflow.

## What is not shipped

Production authentication, production tenant isolation, live integrations, identity verification or rights fulfillment, scanning, privacy deletion, notifications, authoritative retention decisions, enterprise migration, managed encrypted backups, tamper-resistant audit storage, or applicability to legal requirements. A register that tracks work is not the same as a service that performs it.

## Versioned workflow runtime (local API)

`SCOPE.md` records coverage gaps; the optional prototype screens are not a conformance claim. Use the loopback API to publish a synthetic definition, open a case pinned to a version, execute explicit transitions at the expected case revision, and read durable accepted/refused events. See `test/workflow-http.test.js` for a complete reproducible example.

| Method | Endpoint | Details |
| --- | --- | --- |
| POST | /api/workflows/definitions | Demo publisher; definition and expectedVersion, which must be 0 for new definitions |
| GET | /api/workflows/definitions/:id/:version | Read the immutable published version |
| POST | /api/workflows/instances | Demo analyst; definitionId, optional version and title |
| GET | /api/workflows/instances/:id | Read case and current revision |
| POST | /api/workflows/instances/:id/transitions | Demo analyst or reviewer; transitionId, expectedRevision and any required fields |
| GET | /api/workflows/audit | Read separate local workflow event log |

POST requests use JSON and `X-Demo-Actor: publisher`, `analyst`, or `reviewer`. These are demo identities, not passwords or trusted user identity. The workflow state is persisted alongside the main local dataset in a separate file. The assessment entrypoint now invokes a dedicated embedded instance of this workflow runtime, using pinned workflow definitions and a mandatory expected assessment revision. The browser submits that revision through the assessment endpoints; it does not call the separately published workflow sandbox directly. Legacy synthetic assessment rows are anchored at the initial saved state on load without replaying prior decisions; original audit events remain the historical evidence. Test with `test/assessment-workflow-http.test.js`.

### Synthetic assessment routing

New vendor intake assigns a versioned standard privacy or enhanced privacy
questionnaire; an AI declaration adds a separate AI risk assessment. Each
assessment records the assignment reason, form ID/version and its own pinned
workflow instance. Both draft saves and submissions validate active answers on
the server. Submission additionally requires each active mandatory answer. Closing
a branch drops its answer from the current form, while previous audit entries
remain unchanged. Existing records retain their original two-question contract
and workflow history on upgrade. These are fixed, fictional definitions for the
standalone build, not an admin publishing system or verified customer settings.

### Privacy rights workflow (local simulation)

Open **Privacy rights** in the workbench. The analyst opens a case with a
fictional note, owner, and configurable UTC-calendar-day due date. The reviewer
records identity separately from case progress. Only the assigned owner can
begin and document fulfilled cases. A failed review permits a separate
no-disclosure closure. This does not verify a real requester, calculate a legal
deadline, or release information. Legacy register rows remain visibly separate.
The case ID, revision, status changes and refusals are traceable through the
case history and the synthetic JSON audit export.

### Privacy incidents (local simulation)

Open **Incidents** to log fictional affected scope, triage severity, record
containment and findings, and add evidence references that do not point to
external systems. Elevated investigations need extra evidence before an
independent reviewer can decide the simulated need for notice. A request for
more information returns the incident for additional work. A simulated required
notice needs a recorded mock plan before closure; nothing is sent. The current
record and exported audit retain past decisions and refused actions, while
generic historical register entries remain separate. An analyst and a separate
reviewer can publish a versioned [incident workflow policy](INCIDENT-POLICY.md)
for new cases, with severity/scope routing and configurable simulation targets.

### Data mapping

Open **Data mapping**. Add fictional systems, datasets and processing
activities, then connect them using typed, directed links. Inspect direct
usage and transitive upstream/downstream lineage per record. Link endpoints
and type are immutable; use archival and a new linked record to correct a
flow. Duplicate active links and cycles are refused. Existing generic
inventory and activity rows remain separate, and the JSON download includes
the synthetic map and accepted/refused map history. There are no automated
external scans, work connections or import of live records.

### Privacy notices

Open **Privacy notices** to draft fictional disclosure text, submit it for
independent review and publish an immutable local revision per scope and
channel. No notice is delivered to an external audience.

### Retention and holds (audit-only simulation)

Open **Retention** to draft, review and activate fictional schedules. A
preview records the calculated UTC due date, the exact active schedule
version, and any currently active holds. To simulate disposition, the
server checks the schedule and holds again. Only an eligible preview under
the same current schedule may produce an audit-only receipt. The fixture
record and all external data remain unchanged. Generic historical register
entries are excluded from evaluation.

### Risk and controls (local simulation)

Open **Risk and controls**. Scores are likelihood times impact (both 1–5).
A mitigation requires an independently verified link and a latest passing
test whose evidence was accepted by a separate reviewer. Failed, superseded
or unreviewed tests do not reduce the score. Reductions use the largest
applicable value per dimension, not the sum. The synthetic JSON export
includes scoring inputs, evidence decisions and accepted/refused audit
events; it is not a certificate or real test execution.

### Vendor monitoring (local simulation)

Open **Vendor monitoring** to track a fictional intake vendor. Each cycle
has a reproducible score, independent evidence review, and the exact
assessment decisions for that cycle. An approved cycle has a UTC renewal
date. A material change or renewal creates new assessment workflows and
requires fresh evidence; historical approvals remain unchanged. The mock
intake handoff remains separate from these monitoring cycles. No real
screening, communications, risk exchanges, or external jobs are connected.

### Work queue

Open **Work queue** to see actions derived from the current state of
assessments, rights, incidents, vendor monitoring, notices, retention and
control evidence. Filters use the demo owner, workflow and due-date bucket.
Open a task to focus its source record, or download the same filtered queue
as JSON. Completing the source action removes or advances the task; there
is no separately stored task or notification. Demo owner filters are not an
access control.

### Policies and documents

Open **Policies and documents** to draft and independently review a fictional
policy or evidence document. An evidence revision must link to at least one
existing typed record. Publication preserves immutable, hash-identified
revisions. In-app viewing and downloads use local role checks and record an
audit event without putting document text in the generic state or audit
export. Demo identities are selectable; isolated mode uses signed-in local roles.
The server is loopback-only. Scoped governance attachments support synthetic PDF,
modern Office, text/logs, CSV/TSV, JSON/JSON Lines, plain Markdown, and common raster files as opaque downloads only.
See [attachment types, limits and validation](DOCUMENT-ATTACHMENTS.md). No files
are sent outside the local workspace.


### Synthetic schema discovery and reviewed inventory import

In **Data mapping**, choose a bundled synthetic fixture and version, then
preview the proposed system, datasets, field names/types and hosting links.
Field labels provide deterministic classification hints, not verified sensitive
data findings. The fixtures contain schema only, with no example values.
Preview does not write inventory or audit. Apply verifies the same workspace,
account and map revision before writing all accepted changes as one local
transaction. An unchanged repeat is a no-op. A newer fixture can update
schema provenance and keep prior versions; it cannot overwrite manual owner,
name or detail, roll back schema, revive an archived link or import through a
name conflict. No file, URL, external scan, sample values or uploads are accepted.


### Simulated requester self-service

The isolated launcher prints a separate `/requester` URL and the path to a
private file of generated synthetic access codes. The requester can choose a
request type once and check the status of that case. The workspace and fictional
alias are fixed by provisioning, not requester input. Scope is not inferred
from a receipt number, browser operator session, or query parameter. Codes
expire and are neither persisted in workbench data nor sent in URLs. Clearing
the code removes it from the page; it is not saved in browser storage.

The intake is recorded once in the regular rights queue. An internal owner and
separate reviewer still control the simulated case lifecycle. The requester
receives only a receipt, date, selected request type, and coarse status.
Reviewer notes, other cases, evidence, identity internals and data disclosures
are not available. This feature is disabled in the ordinary demo, and is not a
public intake or real requester-identity verification service.


### Local trust center publication

In a provisioned isolated workspace, open **Trust center**. The analyst picks
bundled fictional copy and submits an immutable version; the reviewer approves
that exact version or returns it with an internal note. The analyst then
publishes the approved version to a separate loopback visitor page, or withdraws
the current publication. A new draft or approval never replaces what's
published until the analyst explicitly publishes it.

The visitor page uses a predefined site slug and exposes only the active
card's heading and description. It has no operator endpoints, IDs, notes,
evidence or drafts. The normal demo has no visitor route. Nothing is deployed
or disclosed externally; no custom text, attachments, or certification is
accepted as public content.


### Synthetic employee policy attestations

Run the isolated launcher, publish a fictional policy in **Policies and
documents**, then assign its exact published edition in **Policy attestations**.
The launcher prints a local employee portal URL and a private file containing
separate generated employee test codes. Each code can read only its assigned
editions. The employee must explicitly acknowledge the displayed edition; a
repeated acknowledgment returns the same local receipt. Publishing a newer
edition never replaces an assignment or transfers a prior acknowledgment.

The operator's assignment history and audit retain the edition digest and
a locally authenticated receipt. The receipt's message authentication code
is recorded for engineering verification; it is not a legal electronic
signature or externally verifiable credential. No employee directory,
real credentials, notices, or production access are used.


### Governed data dictionary

Open **Data dictionary** to draft fictional sensitivity, processing-purpose, or
data-domain terms. A distinct reviewer approves or returns a submitted term
version. An analyst can pin the currently approved version to a compatible
inventory node. Approval of newer copy never repoints existing consumers.
Review the consumer list and detach the exact pin before retiring the term
or archiving an inventory node. The audit and map exports expose scoped
references and decisions; they do not classify or scan real records.


### Workflow studio

Open **Workflow studio** to load an original example into a structured editor
for display names, states, transitions, permitted roles and required fields.
The publisher explicitly publishes a validated definition against its current
version. The initiator starts a case pinned to a chosen published edition.
The studio shows the server's allowed actions for the current revision and
the reasons other transitions are blocked. The separate reviewer must satisfy
the pinned role and independence rules. Audit and immutable versions remain
in the synthetic sandbox, independent of application-owned assessments.
Use the studio-only identity selector in the demo, or the provisioned operator
roles in isolated mode. No code evaluation, external automation or transport.
