# Composed release: processing-register reference rework

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test --test-concurrency=1 test/browser-release-processing-rework.test.js
```

This test uses the actual temporary SQLite release launcher, five independent Chromium contexts, and synthetic Harbor/Orchard workspaces. HTTP seeds the original approved entry and later updates its linked map, dictionary, and retention prerequisites. The workflow under test performs eight real keyboard-triggered mutation requests (two deliberately refused), five real file downloads, and the keyboard reload steps.

| Browser action | Result witnessed |
| --- | --- |
| Open history, download version 1, draft version 2 | The first approved file has a checked SHA-256 content checksum and exact mapped activity, lineage, dictionary edition, and 90-day retention. Draft creation does not publish anything. |
| Submit the draft after the linked dataset is renamed | The draft still showed its previous summary before submit; submission pins the current renamed map record, keeps the then-current term, and leaves the current approved export byte-identical to version 1. |
| Try to approve pending version 2 after the linked term changes and retention is superseded | Received `409 PROCESSING_REFERENCES_CHANGED` and displayed explicit Return guidance. The approved register does not change, and the pending version and revision are unchanged. An independent reviewer returns the old submission. |
| Attempt approval from another tab still showing the pending review | Received `409 STALE_REVISION` for the same revision the winning return used. The entry-local alert receives focus, Tab reaches Reload, and a successful reload focuses the exact entry title and shows the return without obsolete decision controls. |
| Edit the returned draft and use Space to select the replacement retention | Editing shows the old retention is no longer eligible, keeps the same still-eligible term ID with its now-approved edition, and requires Save before Submit. The saved payload contains only the replacement retention ID. Resubmission pins the renamed dataset, approved term edition 2 and active retention version 2. |
| Approve independently, then download current and both historic versions | Current approved bytes match the exact version 2 history and its changed checksum. The historical version 1 bytes match the original download exactly. Audit confirms one published event for each version and one return of version 2. |
| Sign in as Orchard reviewer and Harbor case operator | Orchard has no Harbor record, exact historical download is not found in Orchard, and its current export is empty. The case operator has no register tab and the scoped read is denied. Chromium made no off-origin requests. |

Existing mobile Chromium coverage separately checks first draft creation and transfer recipients. The new pass does not claim every reference type, unauthorized role, browser, error-retry variant, or real data import. The sole runtime change fixes the reproduced stale keyboard-review problem: the 409 originally dropped focus to the page body and offered Reload only in the global notice. The exact entry now retains a focused, local recovery path, with no server/export changes.
