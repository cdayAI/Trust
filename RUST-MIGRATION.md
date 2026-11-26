# Rust core migration

This is the compatibility-preserving backend migration. The browser and
Node HTTP/session, authorization, audit and persistence layers remain unchanged.
The portable Rust core runs as a dependency-free WebAssembly module within Node, with no imports,
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
- Workflow definition reachability, revision checks, transition planning,
  independent review, required field validation and contributor updates.
  The Rust plan supplies normalized fields and new contributors; Node
  constructs and persists the existing event and snapshot shapes.
- Assessment answer validation, conditional visibility, required fields,
  integer and choice checks, with exact UTF-16 trim/length semantics.
- Storage scope, positive generation and snapshot schema validation, plus
  encrypted backup header/length validation. SQLite transactions, file
  publication and authenticated encryption remain in Node.
- Incident review-readiness and retention hold/disposition precedence.
- Risk-control score bands, mitigation eligibility, largest verified
  reductions and vendor risk tiers.
- Session-cookie parsing, duplicate-cookie refusal and account expiration
  checks. Identity providers, random tokens, cryptography and session maps
  remain in Node.
- Aggregate reporting filters, date/month grouping, counts and distinct
  workflows in bounded chunks; Rust receives only numeric dimensions.
- HTTP request-boundary decisions for loopback access, corporate host/TLS and
  request-target checks, cross-origin writes, JSON media types and binary-upload
  encoding. Node still owns HTTP parsing, sockets, TLS and streaming limits.
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
and declares its ABI, byte length and SHA-256 in the release manifest. The
build stages a verified, single-link copy of Cargo's output before packaging. It
requires Node, not a Rust compiler or package install. A missing, corrupt,
incompatible or disabled Rust module fails startup; use a separate original
source release if rollback is necessary. The manifest detects accidental
corruption, not publisher authenticity; distribute the archive digest by a
trusted channel. CI checks archive byte reproducibility, both launch paths,
and missing/tampered binary refusal. No live deployment is authorized.

In a developer checkout, `npm run start:rust -- --check` explicitly requires
the locally built Rust core. Do not compile inside a previously verified exact
tree because build output changes the tree.

## Native SQLite driver (opt-in, developer checkout)

The native Node-API Rust driver implements the existing fixed SQLite operations,
including scoped snapshots, transactions, generation checks and integrity checks.
The exclusive release lease and actual SQLite runtime probe also use the selected driver.
The application ID and schema version stay unchanged; the Node reference driver
remains the default. File safety, authorization, authenticated encryption, and
backup publication remain in the host. The native binary is not part of the
portable WebAssembly release and must be built for the target platform.

```sh
rustup toolchain install 1.95.0 --profile minimal
npm run build:rust
npm run build:rust-sqlite
npm run test:rust-sqlite
TRUST_SQLITE_DRIVER=rust TRUST_RUST_CORE=required npm run start:release -- --check
```

The native build requires a C compiler for bundled SQLite and the committed Cargo
lockfile. CI enforces the committed lockfile rather than resolving unreviewed
versions at build time. Explicit
native selection fails closed if the driver is missing or incompatible; there
is no automatic fallback.

### Platform-bound native Rust release

After building both Rust artifacts, create a target-bound package:

```sh
npm run release:native-rust -- /private/path/mvw-trust-native-linux-x64.tgz
```

Extract into a clean private directory, run `npm run release:verify`, then
`npm run start:release -- --check`. The manifest binds both compiled artifacts,
the native storage ABI, the architecture and Node-API minimum. This package
requires both the Rust core and native SQLite driver; explicitly disabling
either is rejected. The source-only and portable Wasm variants remain separate.
CI qualifies Linux x64/ARM64, macOS x64/ARM64, and Windows x64 independently.
Only targets with a green build and extracted startup should be distributed. The digest
checks detect corruption and are not publisher signatures; verify the archive
digest via a trusted channel before executing the native addon.

## Measured performance

`npm run benchmark:rust` compares the JS/Node reference, Wasm/Node, and
Wasm/native SQLite on the same synthetic workload in alternating order,
reporting p50/p95 latency and throughput without a forced speedup claim.
CI reports the median of three trials per mode.

## Native HTTP transport (developer opt-in)

The native Hyper listener binds IPv4 loopback only. A private Unix-domain
socket in the owner-only, leased release directory connects to the existing
Node application handler. A random per-launch marker travels through an
inherited pipe and is required on every internal request. Direct private
requests, forwarded identity and browser-supplied markers are refused or
discarded. Connections and request lifetimes are bounded; Hyper owns HTTP
framing, while the application retains body limits, authentication, audit
writes and domain logic.

```sh
npm run build:rust-http
npm run test:rust-http
TRUST_HTTP_TRANSPORT=rust TRUST_RUST_CORE=required TRUST_SQLITE_DRIVER=rust npm run start:release
```

Linux developer builds only. This listener is not yet included in release
archives. Corporate TLS/OIDC continues to use the Node listener, and arbitrary
application mutations still execute in Node. Native HTTP is an explicit
transport selection, not a claim of a complete standalone Rust backend.

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
