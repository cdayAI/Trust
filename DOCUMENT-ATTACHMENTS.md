# Governance document attachments

In **Policies and documents**, open a draft as an analyst and choose one or
more local files in **Fictional attachments**, or drag and drop them on the
same picker. Check the selection, then select **Upload attachments**.
If a file fails, nothing in that selection is uploaded. Fix or remove the
listed files and retry. Use only synthetic files. The app cannot tell whether
a file contains real data.

| Format | Supported extensions |
| --- | --- |
| PDF documents | `.pdf` |
| Modern Office | `.docx`, `.xlsx`, `.pptx` |
| Printable UTF-8 text and logs | `.txt`, `.log` |
| Tabular or structured UTF-8 data | `.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson` |
| Plain Markdown | `.md`, `.markdown` |
| Raster images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tif`, `.tiff` |

Limits are 16 KiB per TXT, 1 MiB per other file, and up to four files and
4 MiB combined per upload. Each revision can hold four attachments. Each
workspace can hold up to 256 files and 8 MiB of raw attachment data; old
published revisions count toward these limits. Only the exact versioned
single-file and batch upload endpoints have larger JSON request caps for
base64 overhead; other commands remain capped at 32 KiB. The server accepts
at most two simultaneous batch uploads.

The server checks safe filenames, supported extensions, and the declared MIME
type where the browser provides one. It validates the bytes independently.
Allowlisted Office packages are checked inside bounded stored/deflated ZIP
entries (256 entries, 2 MiB per expanded part and 8 MiB expanded total).
Encrypted archives, nested archives, unsupported parts, Office macros,
external relationships, linked or embedded objects, custom UI and printer
presets are rejected. A valid Office file using those features, some newer
conventions, or a large template may need a simpler macro-free export.
CSV and TSV reject formula-like fields. JSON must contain a top-level object or
array. JSON Lines must contain one object per line without blank records (up to
10,000 records). Markdown permits plain document formatting but rejects raw
HTML, embedded images and Markdown link syntax. Logs must be printable UTF-8
without terminal control codes. No text type is rendered from attachments.

WebP is limited to nonanimated images, BMP to supported uncompressed DIB
variants, and TIFF to classic TIFF. Raster images are inspected structurally,
never decoded or previewed. Legacy Office (`.doc`, `.xls`, `.ppt`), RTF,
OpenDocument, Apple iWork, and saved email are not accepted: their containers or
control formats can carry macros, nested resources, embedded objects or links
that this validator does not inspect. Convert these to a supported file such
as PDF, macro-free modern Office, or plain text. HTML, SVG, executables,
scripts, encrypted or macro-enabled Office, and arbitrary archives are also
unsupported.
PDF checks are structural and reject some visible active actions, but are not
a sanitizer. **Format checks do not establish that a file is safe to open.**

Uploads require the current document workspace revision. The batch endpoint
validates every otherwise eligible file and commits the entire selection once
using the currently selected JSON or SQLite store. A successful batch advances
the document revision once. A refused batch changes no attachment bytes or
document revision; the refusal can still be audited. An analyst may remove
attachments while the revision is draft; submission locks them for review; a
reviewer may return the revision or publish it locally. Published revisions
keep an immutable attachment list and a new revision starts empty. Reviewers
can download drafts they are allowed to review and case operators can download
only published revisions they are allowed to read. Employee attestations apply
only to policy text, not to its files.

Attachments use generated IDs and never use filenames as storage paths. The
system checks integrity and serves the original bytes only through a scoped,
audited download using `application/octet-stream`, `nosniff`, a sandbox CSP,
and no caching. There are no inline previews or public file URLs. Revision
lists contain metadata only and general state/export views omit the files.
Audit events contain opaque IDs, not filenames or bytes.

This local synthetic workflow stores the original bytes in revision state.
There is no malware scanner, content classification, dedicated object storage,
external sharing, or production retention integration.

## Optional manual quarantine

Launch the local isolated sample with `TRUST_ATTACHMENT_REVIEW=manual npm run start:isolated`.
The server API can provision selected isolated workspaces with
`isolated.attachmentReviewWorkspaces: ['workspace-id']`. Each selected workspace
must have no existing attachments and must have separate analyst and reviewer
accounts. Once activated, the policy is stored per workspace alongside the
documents and survives restarts, removal of the launch flag, and ordinary
verified SQLite backup/restore. There is no runtime switch to bypass it. Never
downgrade a quarantined workspace to application code that does not enforce
this policy.

A valid single or batch upload stages files atomically. Their authors and
reviewers can see metadata only, and no role can download pending, rejected or
invalid-quarantine-state bytes. The reviewer can reject a file or match the
SHA-256 of the independently verified original from a trusted external
source supplied through an already authorized separate process. The reviewer
cannot retrieve or preview the quarantined bytes through the app, and the app
does not send files anywhere. Only a separate signed-in reviewer can decide.
A draft cannot be submitted until the analyst removes rejected files and
remaining files have been released. Releases are audited manual decisions,
**not malware scans or attestations that a file is safe**.

This slice keeps opaque bytes in the same transaction and backup as the
document snapshot. Quarantined/rejected bytes are retained and count toward
the existing file and storage limits until a draft author removes them;
historical backups can retain the removed bytes. It does not implement
dedicated object storage, disk-level isolation, a malware scanner, secure
erasure, or live migration of legacy attachments. Do not use it for real
workplace data.

## Optional larger PDF batches

The isolated SQLite launcher can opt into PDFs up to **4 MiB each**. The
existing **4 MiB per batch**, four attachments per revision, and **8 MiB per
workspace** ceilings still apply. Non-PDF formats keep their existing limits,
and the regular JSON upload route still uses its original limits. Manual
quarantine is required. For a disposable synthetic workbench:

```sh
scratch=$(mktemp -d)
TRUST_SQLITE_FILE="$scratch/trust.sqlite" TRUST_ATTACHMENT_REVIEW=manual TRUST_LARGE_PDF_BATCH=1 npm run start:isolated
```

The browser uses an authenticated raw-binary request when a PDF exceeds the
usual 1 MiB limit. The exact document-revision route accepts a bounded
4 KiB manifest and four MiB of uncompressed payload bytes, rejects any missing
or surplus bytes, and shares the existing two-upload concurrency cap. A stalled
binary body is disconnected after 20 seconds. Every selected file is validated
before one SQLite commit; the same manual quarantine and scoped forced-download
rules apply. To opt in from an embedded isolated server, set
`isolated.largePdfAttachmentWorkspaces` to a subset of its explicit
`attachmentReviewWorkspaces` and provide a SQLite file.

This is an incremental transfer improvement, **not** a high-volume document
store. Bytes remain encoded in the same bounded database snapshots and
verified backups. Disabling the upload flag prevents new larger uploads
without disabling review or legitimate download of previously stored
records. Test clients and operations staff should keep the app version needed
to read the stored PDF profile before restoring these backups.

For larger files or more data per workspace, the next step is a separate
transactional, tenant-keyed SQLite BLOB table with an explicit upgrade and
backup-format version. Store only references in the workbench snapshot;
prove restore covers referenced blobs and metadata from the same transaction,
reject missing or orphan payloads, and verify retention before enabling GC.
Do not lift request/workspace bounds before that path and snapshot-load
tests are available. No external storage or malware scanning is configured.

Run focused HTTP and browser journeys:

```sh
node --test test/governance-document-attachments.test.js test/attachment-binary-batch.test.js
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium npm test
```
