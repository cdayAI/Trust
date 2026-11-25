# Synthetic policy training

Start the local isolated launcher (`npm run start:isolated`); it prints the
synthetic learner portal address and a private file with the test learner
codes. These codes are different from the operator, requester and employee
attestation codes. Use only fictional data.

1. Publish a fictional policy edition in **Policies and documents**.
2. As the analyst, open **Training**, draft a course against the published
   edition and the bundled exercise, then submit it for review.
3. An independent reviewer can return the course for changes or publish it.
   Create a new course to train on a newer policy edition. Publishing fixes the
   course revision, exact policy digest and bundled exercise version.
4. The analyst assigns the published course to a provisioned local learner.
   A course can be assigned once per learner. The analyst and reviewer can
   inspect progress in the course.
5. The learner signs in to **My training** with their synthetic code, opens
   their assignment, reads their pinned policy edition and completes the
   three-question exercise. A perfect score passes. There are five attempts
   per cycle and an analyst can reset one exhausted assignment once.
6. On completion, the learner can download a JSON receipt. The receipt binds
   the assignment, course, workspace, version and score with a local HMAC.
   Replays return the same receipt. The operator can see completion but does
   not see individual learner answers.

The policy text is visible only to the assigned learner in the scoped
portal (the ordinary policy role rules still govern the operator views).
Training state and receipts do not appear in the global project response.
No files, external mail or training data leave the workspace. The bundled
exercise is publicly reviewable synthetic code: this is not a proctored
test, workforce credential, production learning-management integration,
or audit certification. Receipts are signed, not encrypted. The local
launcher regenerates synthetic codes and its receipt key when restarted;
durable receipt verification requires the original provisioned signing key.

Run the training test, including the optional Chromium journey:

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test test/training.test.js
```
