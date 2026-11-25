# Governance document attachments

In **Policies and documents**, create a fictional draft as an analyst, choose a
local file in **Fictional attachment**, then select **Upload attachment**. Use
only synthetic files. The app cannot tell whether a file contains real data.

| Format | Supported extensions |
| --- | --- |
| PDF documents | `.pdf` |
| Modern Office | `.docx`, `.xlsx`, `.pptx` |
| Printable UTF-8 text and delimited data | `.txt`, `.csv`, `.tsv` |
| Raster images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tif`, `.tiff` |

Limits are 16 KiB per TXT, 1 MiB per other file, four attachments per revision,
and 256 files and 8 MiB of raw attachment data per workspace. Old published
revisions count against workspace limits. Only the exact versioned upload
endpoint has a larger JSON request cap for base64 overhead; other commands
remain capped at 32 KiB.

The server checks safe filenames, supported extensions, and the declared MIME
type where the browser provides one. It validates the bytes independently.
Allowlisted Office packages are checked inside bounded stored/deflated ZIP
entries (256 entries, 2 MiB per expanded part and 8 MiB expanded total).
Encrypted archives, nested archives, unsupported parts, Office macros,
external relationships, linked or embedded objects, custom UI and printer
presets are rejected. A valid Office file using those features, some newer
conventions, or a large template may need a simpler macro-free export.
CSV and TSV reject formula-like fields; WebP is limited to nonanimated
images, BMP to supported uncompressed DIB variants, and TIFF to classic TIFF.
Raster images are inspected structurally, never decoded or previewed.
Legacy Office formats (`.doc`, `.xls`, `.ppt`), macro-enabled Office, RTF,
HTML, SVG, executables, scripts and arbitrary archives are not supported.
PDF checks are structural and reject some visible active actions, but are not
a sanitizer. **Format checks do not establish that a file is safe to open.**

Uploads require the current document workspace revision. An analyst may remove
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

Run focused HTTP and browser journeys:

```sh
node --test test/governance-document-attachments.test.js
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium npm test
```
