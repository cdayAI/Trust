# Rust core migration

This is the compatibility-preserving backend migration. The browser and
Node HTTP/session, authorization, audit and persistence layers remain unchanged.
Rust runs as a dependency-free WebAssembly module within Node, with no imports,
filesystem access, separate process, native addon or network. The ABI exchanges
bounded byte arrays and integer results. Rust uses checked indexing and owned
memory; no unsafe blocks, third-party Rust crates or custom cryptography.

## Ported paths

- Structural validation of PNG, JPEG, GIF, WebP, BMP and TIFF attachments.
  Existing extension/media-type limits and failure messages remain in Node.
  No content is rendered or decoded and this is not a malware scanner.
- ZIP central/local header agreement, bounded extra fields, safe entry names,
  duplicate rejection, data descriptors and contiguous compressed spans for
  DOCX, XLSX, PPTX, ODT, ODS and ODP. Node keeps the document-specific
  allowlists, bounded inflate, CRC verification and XML profile checks.
- Binary attachment-batch header and exact contiguous file layout, with
  the existing 4 MiB and four-file budget. JSON shape and media rules remain
  in Node; only the header and size vector cross the Wasm boundary.
- Workflow definition reachability and independent transition authorization,
  including legacy contributor IDs.
- Risk-control score bands, mitigation eligibility, largest verified
  reductions and vendor risk tiers.
- Session-cookie parsing, duplicate-cookie refusal and account expiration
  checks. Identity providers, random tokens, cryptography and session maps
  remain in Node.
- Breadth-first graph lineage and cycle prevention in the inventory data map.
- Directed cycle validation of synthetic fixture migrations.
- UTC calendar and business-day deadlines, including weekends and closed dates,
  and retention due-day arithmetic.

The transitional JavaScript reference implementations remain available so the
existing offline, text-only source release remains install-free. A built
artifact is used automatically in a developer checkout. Invalid or incompatible
artifacts fail startup rather than silently falling back. This is not a claim
that Rust is faster; benchmark both paths before changing deployment defaults.

## Build and verify

Install the pinned compiler and the WebAssembly standard library once:

```sh
rustup toolchain install 1.85.1 --profile minimal --target wasm32-unknown-unknown
npm run build:rust
npm run test:rust
```

Run the Node server with TRUST_RUST_CORE=required to fail closed if the compiled
module is missing, or TRUST_RUST_CORE=off to run the existing JS reference.
The default auto mode uses the compiled artifact when present. The dedicated
CI job runs native Rust unit tests, required-mode integration/parity tests, and
the existing Chromium suite. The standard CI job still verifies the unchanged
JS-only path and text-only release packaging.

The source release includes the Rust source, lockfile, build script and tests,
not the compiled binary or Cargo target directory. Build in a developer
checkout, not inside a previously verified exact-tree source release. Before
making Rust mandatory for offline receiving environments, define a reviewed
reproducible artifact/distribution and rollback procedure.

## Next migration stages

1. Extend archive malformed-input fuzzing and performance comparisons before
   removing the JavaScript reference parser.
2. Migrate pure workflow transitions and reporting calculations with exact
   audit-event and revision parity.
3. Migrate HTTP routing and authorization together, using the existing API
   contract and independent identity/permission tests as acceptance gates.
4. Migrate storage last; preserve the SQLite schema, encryption, backup,
   migration and transaction semantics. Verify crash recovery and concurrency.
5. Remove transitional implementations only after CI and release parity and
   measurable performance evidence. The UI can remain browser JavaScript.

Do not connect to live systems or infer production readiness from this migration.
