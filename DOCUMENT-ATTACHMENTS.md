# Governance document attachments

In **Policies and documents**, create a fictional draft as the analyst, choose a
local text file in **Fictional .txt attachment**, and select **Upload attachment**.
A draft can have at most four attachments, each at most 16 KiB. Each workspace
can store at most 256 files and 2 MiB of raw attachment bytes, including files
in older published revisions. Uploads require a current workspace revision.
Use only synthetic fixtures; there is no automatic detection of real data.

Only ordinary filenames and valid, nonempty printable UTF-8 text are allowed.
The server checks the extension, declared media type, bytes and limits.
Markup-led documents, RTF and binary controls are rejected. Stored files use
generated IDs; client filenames never select a storage path. A file is
available only by the revision's **Download attachment** button, never for
inline preview or external publication. The server returns it as an
octet-stream attachment with MIME sniffing disabled and checks its hash and
size before download. Revision lists contain metadata, not file bytes.

The analyst can remove an attachment while a revision is draft. Submission
locks it for review; a reviewer can return the revision to draft for
correction or publish it locally. Published revisions retain their own
immutable attachment list. A new revision starts with no attachments.
Reviewers can read the drafts they are allowed to review. A case operator
can download only if they can read the same published revision under the
existing policy/evidence rules. Employee attestations still apply only to
the published policy text, not its associated attachments. Audit events
record actions and opaque IDs, never filenames or file bytes.

This synthetic local workflow stores file bytes with document revision state.
It has no malware scanner, business content classification, dedicated object
storage, external sharing or production retention integration. The size caps
are deliberate, not a claim of production capacity.

Run the HTTP and browser journeys:

```sh
node --test test/governance-document-attachments.test.js
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium npm test
```
