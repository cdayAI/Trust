# Internal fictional retrieval rehearsal

This is a manual, operator-only API exercise in a local workspace that already
opts in to synthetic requester results. It does not retrieve or discover actual
records. It has no source URLs, uploads, free text, email, external identity
checks, connectors, job runner, or automatic operation. It does not change or
add anything to requester responses.

Start with an **access** request entered through the fictional portal with an
active original code. After simulated identity verification and start of mock
fulfillment, the case must still be open and assigned to the analyst role.
A case-operator, a different workspace, a manual case, and a legacy request
without an original code binding cannot use this exercise.

Use the ordinary local staff session, matching `workspace` query parameter,
and same-origin JSON writes:

| Route under `/api/rights/cases/{caseId}/retrieval` | Role | Body |
| --- | --- | --- |
| `GET` | Analyst; reviewer only after submission | — |
| `POST /retrieve` | Analyst | `{"expectedCaseRevision":3,"expectedRevision":0,"source":"fictional-preference-ledger-v1"}` |
| `POST /submit` | Same analyst | `{"expectedCaseRevision":3,"expectedRevision":1,"digest":"<exact digest from GET or retrieve>"}` |
| `POST /return` or `/approve` | Independent reviewer | Same exact revision and digest body |

Use the actual current revisions from the authorized case and retrieval response.
The bundled source has two fictional buckets. A deterministic selection is
bound to the exact workspace and case. The transform reads only the allowlisted
category enum and counts; it does not copy internal fixture identifiers, notes,
or debug markers. The durable draft contains only the typed projection. It is
sealed to source, workspace, case, case revision, exact original-code binding,
and retrieval revision. Stale case or output revisions cannot be approved.
An analyst can run a new retrieval from a returned or stale revision while the
case remains eligible. Previous redacted versions are not served by this API;
successful actions retain an audit trail. Approval is internal only. The
existing requester release requires its own redacted revision, separate review,
explicit release and original code. No part of this exercise establishes
legal compliance or a real data-retrieval integration.
