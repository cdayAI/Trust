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
- Aggregate reporting filters, date/month grouping, counts and distinct
  workflows in bounded chunks; Rust receives only numeric dimensions.
- Exact HTTP route/role authorization including limited reviewer seats.
  Route expressions are expanded from the existing source-of-truth policy
  using a deliberately small supported grammar; Rust matches typed segments
  and role masks. Record-level checks remain in the application.
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

## Portable compiled release

The original source release remains install-free and uses the JS reference
when the compiled artifact is not available. For a Rust-required distribution,
build in a developer checkout and package the compiled module:

```sh
npm run build:rust
npm run release:rust -- /private/path/mvw-trust-rust.tgz
```

Extract into a clean directory, run `npm run release:verify`, then
`npm run start:release -- --check` before launching normally. This variant
includes exactly one allowlisted binary, `rust-core/runtime/trust_core.wasm`,
and declares its ABI, byte length and SHA-256 in the release manifest. It
requires Node, not a Rust compiler or package install. A missing, corrupt,
incompatible or disabled Rust module fails startup; use a separate original
source release if rollback is necessary. The manifest detects accidental
corruption, not publisher authenticity; distribute the archive digest by a
trusted channel. CI checks archive byte reproducibility, both launch paths,
and missing/tampered binary refusal. No live deployment is authorized.

In a developer checkout, `npm run start:rust -- --check` explicitly requires
the locally built Rust core. Do not compile inside a previously verified exact
tree because build output changes the tree.

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
