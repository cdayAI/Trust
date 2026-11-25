# Populated evidence preservation dispute in the composed release

The isolated navigation ledger counts exposed in-panel controls as observed,
not exercised. High-impact remaining stateful paths include a returned
requester result, conflicting report schedule proposals, audit remediation
reopen, and an outstanding preservation hold racing an evidence disposition
preview. This audit covers the last journey: it puts a published edition and
an independently released attachment in the real composed local SQLite
release and then exercises both author and reviewer controls. Setup uses
authenticated loopback HTTP, not in-panel activations. The browser journey
stays in one synthetic workspace and uses no employer data, real retention
rules, or external services.

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules \
  node --test --test-concurrency=1 test/browser-release-evidence-dispute.test.js
```

| Activated controls | Concrete outcome verified |
| --- | --- |
| Open **Policies and documents**, expand **Preview evidence disposition**, select the pinned rule, enter an early date, submit | Exact edition visible; real route returns 409 `EVIDENCE_NOT_DUE`, in-app error is visible, no preview persists, and the original rule remains selected for correction. |
| Correct the date and submit again; independently open review | A new exact preview is stored with the pinned rule and fictional disposition; the reviewer sees the execution button before any hold. |
| Expand **Place evidence hold**, select reason, submit; attempt the old **Record rehearsal only** from a different browser context | Hold is active; stale action specifically returns 409 `STALE_REVISION`; no receipt is recorded. |
| **Reload documents** | Reviewer sees the live hold and blocking message; the stale rehearsal action is gone. The analyst cannot request another disposition preview while held. |
| Expand **Request hold release**, select reason, submit; separate reviewer opens and uses **Keep evidence hold** | Visible request awaiting independent review changes back to active; the read model also confirms it. |
| Request release again; reviewer selects reason and uses **Approve hold release** | Edition remains, hold is released, review UI explains that existing preview is stale and requires a new preview. It does not re-offer old execution. |
| Request a fresh preview; **Record rehearsal only** as reviewer | New preview ID differs, exactly one independent audit event and receipt persist, and a rerun button is absent. |
| Reload the documents panel, **View fictional text**, **Download attachment** | Same signed-in scoped edition, exact original text, unchanged content hash and attachment metadata, and identical downloaded bytes/hash. No evidence was deleted. |

The run logged **38 control activation occurrences**, not 38 unique controls
or all in-panel affordances. Revisited navigation, repeated actions, form
input/selection, and disclosures each count as occurrences when witnessed.
Keyboard Enter/Space was used for action/disclosure activation. Role sign-ins
and setup seeding are checked separately and not included in that count. The
test reports no uncaught page errors or external requests.

## Still unverified here

This does not cover the lifecycle paths named above outside the hold dispute,
all reason choices, competing approvals at the exact same moment, hold
placement on draft or superseded editions via UI, alternate retention-rule
changes, corporate deployment, real destruction, storage incidents or other
browsers and assistive technology. Other attachment approval, file type,
scope, transfer and backup tests remain independent. No runtime defect was
reproduced by this journey, so it changes only test coverage.
