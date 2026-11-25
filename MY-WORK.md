# My work

In isolated mode, sign into a provisioned analyst, reviewer or case-operator
seat. **My work** shows the next workflow action assigned to that seat, with
the UTC due date where one is defined. A case operator does not get
the all-operator queue or an export through My work. The presenter has no
owner filter and does not return other operators' work, audit events, raw
records, work-history payloads or account lists.

The session's workspace and role are authoritative; each isolated workspace
currently permits only one account per role. This is a role-seat assignment
view, not a model for multiple assignees within the same role. The external
requester and employee-assignment portals are separate products and do not
gain access to these operator tasks. Demo-mode identity switches do not grant
access to My work.

The scoped read model derives the seven existing workflow queues, plus audit
plans, owned corrective actions, independent corrective closure review, and document review, from current records. It avoids a parallel task
store. When a record advances or is transferred, use **Refresh my work** to
see the new next action. No deadline is guessed for a workflow that doesn't
have one. Future multi-assignee identity and standalone workflow-studio tasks
are not part of this version.

To prevent links from opening another user's old or copied assignment, a
record link uses an opaque workspace/account/task key. On click and reload,
the server rechecks assignment and destination permission before opening
and focusing the record. A resolved link does not grant any additional record
rights beyond the underlying workflow access policy. Old and out-of-scope
links return the same unavailable response. There is no export or audit link
in the personal view.

Audit corrective entries use fixed generic labels instead of findings,
audit titles, evidence or action notes. Only the recorded owner account can
receive preparation or submission work. The broad independent reviewer seat
can review a pending closure or return superseded evidence; restricted
document-review seats cannot use this view. A new eligible retest, return,
closure or reopening changes the applicable task and invalidates old links.
The link opens and focuses the exact corrective action in Audit management,
not merely the parent plan. None of these tasks are added to the general
queue or sent as notifications.

## Verification

```sh
node --test test/my-work.test.js
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/my-work.test.js
```

Browser acceptance creates fictional cases, verifies through a separate
reviewer, checks the restricted operator view, focuses the actual linked
record, continues the workflow and verifies that old deep links no longer
resolve. It also opens the assigned audit and policy-review destinations, for
the roles that are entitled to those records.
