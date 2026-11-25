# MVW Trust workspace home

Home is the default for synthetic demo workers and verified local analysts,
reviewers, and case operators. It introduces no new workflow state, real
identity integration, alerts, or data movement.

- **My next actions:** verified local users see actual assigned work (the same
  source as My Work). Demo analysts and reviewers see their chosen demonstration
  role's queue tasks. Each read counts open, overdue, due today, upcoming, and
  no-date tasks at the UTC date shown.
- **Workspace triage:** only analysts and reviewers see cross-role totals across
  the existing shared queue's seven workflows. Workflow and active urgency
  shortcuts open the queue with those filters already applied. My Work can
  additionally include audit/document tasks outside the shared queue; the
  personal count and shared count describe different scopes.
- **Entitled navigation:** Home offers only eligible actions. Case operators
  see their personal count and navigation to My Work, Privacy Rights, and
  Policies and Documents. They receive no aggregate triage, reports, or other
  roles' records. Publisher, identity administration, and ethics roles keep
  their specialized entry views.
- **One local read:** `GET /api/workspace-home` uses the verified workspace and
  role in isolated mode. Only totals and fixed workflow labels/IDs are emitted,
  never task titles, case IDs, links to individual cases, comments, evidence,
  identity data, audit, or credentials. There are no audience, search, export,
  or write options. Demo figures are generated entirely from fictional records.
- **Unavailable versus empty:** a refresh failure has its own retry and permitted
  shortcuts, and never masquerades as zero work. A scoped empty view still offers
  safe next steps. The error does not repeat service response details.

## Verification

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium \
  NODE_PATH=/path/to/playwright/node_modules node --test test/workspace-home.test.js
```

The model test exercises UTC priority buckets (including both overdue and
due-today) and their workflow summary. HTTP covers authentication, workspace
membership, role differences, aggregate-only output and no query/write/export
variants. Desktop Chromium checks live figures, filtered workflows, reports and
incidents destinations, demo identity, solid-surface support and retry. The
desktop Home panel is scanned for automated axe WCAG A/AA findings; that is
not compliance certification. Mobile Chromium checks keyboard navigation,
focus transfer, horizontal fit, case assignment scope, zero-work state after
switching workspace, and unchanged specialist landing. Active overdue and
due-today shortcut button clicks are not independently exercised in Chromium
in this pass (their queue wiring shares the tested filter handler).
