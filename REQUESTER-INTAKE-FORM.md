# Versioned synthetic requester intake

This local workflow lets an isolated workspace with a provisioned synthetic requester portal configure a small typed form. It does not change real privacy rules, collect actual personal information, verify identity, send notifications, or transfer information to another system.

## Try it

1. Run `npm run start:isolated`. In the fictional Harbor workspace, sign in as the intake analyst from the private generated local access file. Open **Privacy rights → Requester intake form**.
2. Include one to three fixed fictional fields and mark which are required: **Fictional service area** (listed choices), **Fictional record count** (integer 0–99), **Include a fictional example** (yes/no). Save a draft and submit it for review.
3. In a separate browser context, sign in as the reviewer. Review the exact draft, return it with a fixed reason or confirm publication. Contributing accounts cannot approve their own work even if later provisioned under the reviewer role.
4. In another context, open `/requester` and enter an unused provisioned synthetic requester code from the generated private file. The requester only sees the current published form for that code’s workspace. If a newer version is published while a form is open, submission stops and offers to load the current form. The requester must review the new form and submit again; old answers are not copied.
5. The resulting staff case pins the exact version and validated values. Later publication does not change that case or receipt. A matching retry returns the same receipt, without creating another request. Staff analysts and reviewers can inspect the captured values. The requester sees the status, receipt and version only. Case operators and raw state projections do not receive the captured values.

Portal workspaces with no published form, including those with a draft under review, keep the existing request-type-only intake. Legacy requests retain their original receipts. One workspace's form changes never configure another workspace's portal. This does not change ordinary manual analyst intake or any separate portal's permissions.

## Verification

Run `node --test test/requester-intake-form.test.js test/requester-portal.test.js`. The checks cover distinct reviewer authorization, strict domain types, missing/oversized/unknown fields, workspace isolation, stale publication, idempotent intake, and restart persistence. The Chromium test requires `RUN_BROWSER_SMOKE=1` and the existing browser setup.
