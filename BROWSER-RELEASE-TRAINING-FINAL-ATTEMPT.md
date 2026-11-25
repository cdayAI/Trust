# Composed release: final training attempts

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test --test-concurrency=1 test/browser-release-training-final-attempt.test.js
```

The temporary synthetic release provisions two workspaces. Fixtures create and independently publish one policy and course in Harbor, and stage four wrong answers per cycle using the ordinary local learner API. In actual Chromium, the Harbor learner opens the pinned policy, selects and confirms answers using Space, and uses Enter to submit the last attempt of each cycle. A separate analyst session uses the real reset control after the first exhaustion.

- First exhaustion still directs the learner to the analyst, who can reset once. The learner reopens the assignment and sees five available attempts.
- Upon exhausting the second cycle, the learner portal says the reset has already been used; there is no submit or receipt control. This survives reopening the assignment. The analyst sees ten attempts and no reset control; an attempted second reset is refused. The persisted record and audit show ten unsuccessful attempts, one reset, no receipt, and no completion.
- The separately scoped Orchard learner has an empty list and cannot read the Harbor lesson. No browser off-origin requests were attempted.

Before the fix, the second exhaustion incorrectly told the learner to request an impossible second reset. The lesson now receives a boolean derived from the same server predicate as reset authorization. No attempt limit, role authorization, completion, storage or signing behavior changes. This is not a claim about every training interaction, browser, or accessibility conformance.
