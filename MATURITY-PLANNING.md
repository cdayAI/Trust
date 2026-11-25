# Program maturity and planning

Use **Maturity planning** to establish a scoped synthetic capability baseline,
set targets, and turn confirmed gaps into a prioritized roadmap. The catalog
has six capability areas: privacy rights operations, incident response, supplier
assurance, inventory governance, retention operations, and policy governance.
This is self-assessment for a fictional workspace, not an industry benchmark,
independent assurance, or a claim about real controls.

1. The analyst creates a plan with a fixed capability scope and a target date.
   Record a proposed baseline and target for every included capability, a
   synthetic scoring rationale, and supporting evidence. If the target exceeds
   the baseline, a concrete action and due date are required.
2. The reviewer decides each **current** evidence submission. Rejected evidence
   cannot be overwritten in review: return the plan for changes and enter a
   revised score and/or reference. The earlier score and decision remain in
   history. Acceptance applies to the exact assessment revision reviewed.
3. Once all current evidence is accepted, a different workspace account
   records reviewer signoff and a rationale. A signed version is immutable.
   Download it from the plan, or create a new draft version with the same scope,
   a new target date, and fresh scoring and review. The old signed report
   remains available even while the next version is in draft.

## Rubric and priority

Levels run from 0 (*Not established*) through 4 (*Improving*). Baseline and
target are weighted averages of explicitly recorded levels using the scoped
catalog weights, rounded to one decimal. They are not shown until every scoped
capability is scored. A baseline is proposed until independent signoff;
the target is always a goal, not proof of achieved maturity.

The roadmap is ordered by **priority score = (target − baseline) × weight**,
with equal scores ordered by earliest due date and then stable capability ID.
Priority is Critical at 9 or above, High at 5–8, Medium at 2–4, and Low at 1.
Each row shows its responsible functional team, due date and action, along
with a capability-specific implementation guide. Dates are UTC calendar dates.
Targets cannot be below the proposed baseline; actions are only required
for positive gaps and cannot be due after the plan version target date.

## Evidence and reports

Evidence may be a fictional `SYN-…` reference, a finalized local audit plan, a
published local policy revision, or a previously accepted passing local
control test. Linked IDs must belong to an eligible source in the current
workspace. The report retains the selected references but does not copy the
source content, attachments or credentials. Reviewing a reference does not
re-run the cited control or prove the underlying real-world evidence.
Use no personal or employer data in prototype records.

An approved JSON report contains the frozen rubric, scores, roadmap, assessment
history and review decisions. The SHA-256 value checks the stored result: it is
not a cryptographic signature or independent confirmation of controls.

- `GET /api/maturity-planning` gets plans and eligible evidence in the workspace.
- `POST /api/maturity-planning/plans` creates a scoped plan.
- `POST /api/maturity-planning/plans/:id/{assess,submit,decide,return,approve,revise}`
  makes a workflow change and requires the current `expectedRevision`.
- `GET /api/maturity-planning/plans/:id/versions/:number/report` downloads the
  approved immutable edition and its digest.

An isolated analyst or reviewer must select their active workspace. A case
operator or workflow publisher has no route or navigation access to this area.
Demo identities exercise the workflow locally with synthetic records only.
