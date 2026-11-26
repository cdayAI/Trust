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
