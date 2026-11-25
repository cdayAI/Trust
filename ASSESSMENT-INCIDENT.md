# Assessment-linked synthetic incident

In a signed-in isolated workspace, an assessment analyst can explicitly log
one fictional follow-up after a DPIA or enhanced privacy assessment has a
direct, independently reviewed approval. An approval does not imply an
incident has occurred. This action is for a separately identified fictional
issue. There is no trigger on approval and no external integration.

1. Open the specific approved **Privacy assessment**. Expand **Log an
   assessment-linked incident**, read the scope, and confirm.
2. The app opens exactly one incident at **Logged**. It copies no questionnaire
   answer, decision note, vendor name, incident severity, or evidence. The
   title and scope are generated and explicitly fictional.
3. Triage scope and severity independently via the regular incident workflow.
   **View approved source assessment** opens the pinned assessment. On the
   assessment, **Open linked incident** returns to the existing record.
4. Reviewers retain their read/review permissions but cannot create the
   linked incident. Synthetic demo identities do not get this action.

## State and replay

`POST /api/assessments/<id>/linked-incident?workspace=<session-workspace>` takes
only `expectedRevision`. It verifies the authenticated analyst's current
membership and exact local source record, typed assessment, approved pinned
workflow, and its corresponding submission/approval audit events from two
different local accounts. It rejects
unrelated standard privacy assessments, AI-only assessments, unfinished or
legacy-baseline approvals, incorrect revisions, unknown sources and mismatched
workspaces. There is no client-supplied incident content or audience.

An incident stores a typed source reference: assessment ID/revision, project
ID, questionnaire ID/version, workflow instance ID, definition ID/version,
workflow revision, and approval audit event ID. No source assessment is
mutated. Incident creation and the one incident-open audit event commit
together. Replay of the same approved revision returns the original incident
without re-opening it or appending another event, and does not replace the
stored provenance. Existing incident policy pinning still applies at intake.
Nothing sends notice or takes action outside this local simulation.

## Evidence and limits

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/assessment-incident.test.js
```

The HTTP regression covers stale/unauthorized/unrelated requests, cross-workspace
scope, exact bounded output, five overlapping retries (one creation), one audit
event, and replay/reopen after SQLite restart. Chromium covers configured DPIA
visibility, no write without confirmation, keyboard creation of the exact
record, ordinary triage, two-way navigation/focus, and role differences on
reload. This is a synthetic relationship, not proof of vendor parity, continuous
incident detection, statutory notification, corporate issuance/identity
validation, or a cross-workspace incident escalation. This test does not run a
linked incident through every downstream investigation branch.
