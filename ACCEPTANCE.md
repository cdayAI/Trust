# Privacy Workbench acceptance checklist

Run the standalone browser demo with `npm start`. Use only fictional data. Do not connect to production systems or real vendors.

## Walkthrough

1. **Review the synthetic seed.** Customer Support Modernization has two fictional vendors: HarborDesk, which does not use AI; and Northstar Assist, which does. Both need a privacy assessment, and only Northstar Assist needs an additional AI-risk assessment.
2. **Try intake validation.** As Alex Morgan (intake analyst), try creating a project with a blank name or a vendor with a blank name. The workbench rejects missing required input; valid project and vendor records are saved.
3. **Submit and review.** Enter a synthetic data summary and safeguards for each required assessment, then submit. The analyst cannot approve their own submission. As Jordan Lee (independent reviewer), return one assessment with a reason, then have the analyst revise and resubmit it. Approve all required assessments as the reviewer.
4. **Exercise the handoff gate and recovery.** Before all approvals, the analyst cannot run the mock integration handoff. After approval, the first attempt visibly fails with a simulated timeout and no receipt. Retry once for a synthetic receipt. The failed attempt remains in the timeline; another send or retry cannot duplicate the handoff.
5. **Export and reopen.** Download the JSON audit file. Confirm it contains the same ordered event history shown in the workbench, including the project/vendor descriptions, review decisions, attempt 1 failure, attempt 2 success, actors, and timestamps. Restart the server and verify that the prior work is still there.

The role switch uses demo identities, not real login accounts or authentication. The mock integration adapter does not contact a real service.

## Automated coverage

Run `npm test` for the API checks. Tests use a fresh temporary data file and a loopback listener, not the demo’s saved data.

### Breadth smoke

Open each area in the workflow catalog: inventory, processing, individual rights, consent, cookies, incidents, third parties, risks, controls, retention, policies, administration, and integrations. For each, open its seeded synthetic record or create a fictional one, confirm the available fields and statuses match that area, and advance it one step if the demo identity is authorized. Restart and confirm saved records and statuses remain. These checks cover workflow shells, not live integrations, automated legal determinations, or production controls.

For the assessment UI smoke test, install Playwright and pass the path to a local Chromium binary if necessary: `RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test test/browser.test.js`.

## Assessment version and stale-action check

Open the same synthetic assessment in two tabs. Both should identify the workflow definition version and record revision. Submit or review in the first tab, then attempt to act on the old record in the second. The second action must be refused without recording a second decision. The pending text stays visible until the operator chooses **Reload latest**. The reload is explicit because it replaces the unsaved form with the current server record.

On the current revision, review with the separate simulated reviewer. Returning the assessment requires a reason and permits resubmission, without discarding the original recorded decision history. Confirm that the approved result and its version references survive server restart. This is a synthetic workflow, not employer configuration or real authentication.
