# Independent governance-document publication

An isolated governance-document edition records an authenticated local account as its originator, the accounts that edited or changed its attachments, and the account that submitted it. A reviewer account that contributed to the edition cannot return or publish it, even if that account was re-provisioned under a different role. Reviewer-only comments do not make the reviewer an author. A return to draft clears the current submission but preserves attribution. New editions start a separate contributor history from their own authored contents. A successful isolated publication also records the deciding account. Raw provenance identities are not returned in the document API.

The same independence check protects manual attachment decisions; the existing uploader and digest requirements still apply. No new attachment formats, scanner, or integrity policy is introduced. **My work** and the document view show review controls only when the signed-in account is eligible. The server enforces the same check independently of those controls.

## Historical workflow

- Published editions remain unchanged and read under the existing access policy. They are never rewritten to guess authorship.
- For a historical in-flight edition with no stored provenance, the workbench can reconstruct it from complete existing edition-specific audit events with authenticated account attribution and consistent lifecycle, content hash and attachment identities. It never guesses an account from its current role or a role-only audit event. The next valid change persists the reconstructed identity.
- If an edition cannot be attributed, it remains viewable to staff under the existing policy but read-only and cannot be submitted, returned, independently released, or published. Preserve it as historical evidence and create a replacement document using separately provisioned author and reviewer accounts. There is no administrative override that silently supplies an author.
- The built-in synthetic demo still exercises role-based decisions; it is not a source of attributed isolated authorship.

Run `node --test test/document-provenance.test.js` for direct HTTP role-rotation, migration, and policy checks. Enable `RUN_BROWSER_SMOKE=1` with the existing browser tools for the real rotated-reviewer versus separate-reviewer journey.
