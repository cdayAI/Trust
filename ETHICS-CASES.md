# Synthetic ethics case management

This is an operator exercise, not a reporting line. Never use real reports,
allegations, identities or evidence. There is no public form, file field,
free-form intake, contact mechanism, external transport or actual investigation.

With `npm run start:release` or `npm run start:isolated`, use the separate synthetic investigator and
reviewer seats in Fictional Harbor:

1. An investigator opens a fictional case using an enumerated category and
   priority. Priority cases must use the priority triage path.
2. The investigator begins fieldwork, records enumerated findings based on a
   synthetic evidence option, and submits the latest version with an associated
   disposition. Without a corroborating fixture, only an inconclusive finding
   can be recorded. Valid revision and workflow stage are checked by the server.
3. A separate reviewer can return a submitted finding with a listed reason or
   approve closure. A returned case needs a new finding version to resubmit.
4. Closed cases are immutable. The independent reviewer can download a redacted
   JSON summary limited to the case reference, approved outcome and workflow
   audit activity. It excludes account IDs, exact timestamps, return reasons,
   evidence basis details and internal resource IDs.

The role check is separate from general program and global audit permissions.
Investigators only see their assigned exercises. Reviewers see exercises only
after submission or closure, not intake, fieldwork or returned drafts.
Accepted decisions and findings persist with the case in JSON or SQLite.
A stale decision hides the old review and offers a read-only reload. If a
confirmed write is followed by a failed refresh, reload the cases instead of
repeating the decision. The feature is unavailable in ordinary demo mode. It does not claim
compliance, tamper-resistant logging, or readiness for employee use.

Focused tests: `node --test test/ethics-cases.test.js`. Enable the
Chromium tests using the normal browser test configuration;
`test/browser-release-ethics.test.js` exercises the composed SQLite release.
