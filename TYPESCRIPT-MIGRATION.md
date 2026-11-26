# TypeScript-first migration

Trust is moving toward a TypeScript application and browser layer with the
verified Rust Wasm, SQLite and Hyper components retained. Strict TypeScript
source lives under `typescript/`; the compiler emits JavaScript to existing
runtime paths so Node 22.13 and install-free source and compiled Rust releases
continue to work without a compiler or package installation.

The explicit output inventory is `typescript/manifest.json`. Do not edit
generated JavaScript for listed modules. Build using the isolated, pinned
development toolchain in `scripts/type-tools`:

```sh
npm --prefix scripts/type-tools ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build:typescript
npm run verify:typescript
```

Initial strict modules: HTTP policy, native binary manifests, Wasm ABI,
runtime checks, binary batch framing, assessment questionnaires, access
policy and workspace home, plus visitor and employee portals. Native and
legacy interfaces have explicit structural contracts. Untrusted JSON remains
unknown until validated; a static type is not an authorization check.

The committed compiler lock is enforced with npm ci. CI compiles strict
TypeScript and compares committed output byte-for-byte, then runs existing
API, Chromium, native release and recovery checks. No runtime dependency
changes or production deployment. Remaining JavaScript modules are not
claimed migrated, and the current SQLite snapshot schema is unchanged.

## Storage and reporting optimization

Strict storage-driver and report contracts validate the boundary to SQLite,
including the native driver. The generation-aware read cache retains one
immutable committed workbench snapshot per store, checks SQLite on every
read, and never supplies cached data to a write transaction. Report rows
are indexed by workflow only for the same immutable snapshot and filtered
audit reference. Role, scope, current dates, and authorization remain live.
The Wasm bridge allocates a smaller buffer for bounded indexed rows.
Set TRUST_SNAPSHOT_CACHE=off to compare the original read path. CI measures
both variants on the same runner; this does not change the schema or claim
normalized row-level persistence. Full-row writes still remain to be migrated.

## Incremental intake experiment

`TRUST_INCREMENTAL_INTAKE=on` enables one narrow, generation-checked SQL
append of a new staff rights case and its audit event within the existing
transaction. Both drivers execute fixed SQL; only the appended JSON crosses
the native boundary. The snapshot schema and backup representation are
unchanged. Unrelated field changes, missing rows, or non-append shapes use
the existing full save. The feature defaults off pending benchmark evidence.
SQLite still updates a JSON snapshot blob on disk, so this is not a normalized
row-level storage migration. CI compares cached native with incremental native
and tests rollback, generation checks, exact payload and workspace isolation.

## Typed workflow engine, queue and scheduling

The workflow engine and HTTP adapter define separate input-validation, actor,
normalized definition, published version, instance, transition, and event
contracts. Command results are discriminated unions; failed commands retain
exact audit semantics and Rust policy decisions. The assessment adapter uses
the same typed engine. Work-queue projections, signed cursors, assigned tasks,
pinned report snapshots, scheduling callbacks and fictional discovery fixture
schemas are also checked under strict TypeScript. Existing persistence, route,
role, and browser regression contracts remain the release gates. Legacy stored
workflow snapshots keep their original shallow schema validation; type contracts
do not imply comprehensive new stored-data validation.

## Typed operator screens

The home dashboard, shared queue and assigned-work inbox consume typed server
projections and preserve cursor/reload behavior. The identity roster, governed
dictionary, employee policy administration and trust center use explicit view
and action models, typed form inputs and narrowed error handling. The remaining
JavaScript shell is represented by a small classic-script ambient contract;
there is no runtime module loader or extra browser dependency. These static
response projections do not replace server-side authorization or input checks.

## Access, identity and readiness

Workspace sessions and provisioning, membership revisions, requester grants,
saved-email attachment profile validation and operational readiness use
explicit TypeScript contracts. Authorization and untrusted-input checks remain
runtime decisions. A store-level regression verifies the opt-in staff intake
append is selected and commits the new case and exact audit event without a
full JavaScript snapshot save.
