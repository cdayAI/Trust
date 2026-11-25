# Run and verify MVW Trust locally

**Synthetic, unofficial prototype.** Use only fictional records. None of the
commands deploy the application or require a GitHub, Marriott, or cloud account.

## Install-free quickstart

Use Node.js 22.13.0 or newer. Node 24.22.3 is the pinned CI toolchain.
You do not need `npm install` for the application. With Node and its normally
bundled npm, open a terminal in the source or extracted archive and run:

```sh
npm run verify:runtime
npm start
```

Open **http://127.0.0.1:4173/** on the same machine. Demo mode starts
with fictional records and an identity switcher, not real authentication.
Stop it with Ctrl+C. To try generated local accounts and separated synthetic
workspaces, use `npm run start:isolated` instead. The launcher prints the
private access-file location. Use the synthetic codes in that file, not a
work password. Starting an isolated launcher again generates fresh codes.

Run the launchers directly if npm is unavailable: `node server.js` and
`node start-isolated.js`. Set `PORT` for a different loopback port if needed;
with `PORT=0` the launcher chooses a free port and prints the actual URL.

## Verify startup and recovery

```sh
npm run verify:startup
npm run verify:runtime -- --sqlite
npm run verify:startup -- --sqlite
```

Startup checks launch child processes on a temporary loopback port, separate
from an existing instance. They exercise a synthetic demo write, isolated
sign-in and sign-out, and refusal to read another workspace. The optional
SQLite check creates disposable databases, backs up a running demo,
validates its checksum, restores to a new file and confirms the same project
and audit history over HTTP. It also launches isolated SQLite mode. All
exercise data and generated access codes stay in a temporary directory and
are removed when the check ends. It never uses an inherited `DATA_FILE` or
`TRUST_SQLITE_FILE`.

For durable data paths and operator recovery procedures, see
[DURABLE-STORAGE.md](DURABLE-STORAGE.md). The default launcher is bound to
loopback and rejects non-loopback requests. In a container or virtual machine,
`127.0.0.1` means inside that network namespace: ordinary container port
publishing to a process bound to container loopback is not a supported
distribution. Do not change the bind address or proxy these modes onto a network.
Production hosting, deployment, approved SSO and operational limits are
separate [readiness gates](ENTERPRISE-READINESS.md).

## Build a reproducible, local source package

```sh
npm run release:local -- ./dist/mvw-trust.tgz
tar -xzf ./dist/mvw-trust.tgz -C /path/to/existing/private-directory
cd /path/to/existing/private-directory/package
npm run release:verify
npm run verify:startup -- --sqlite
```

The local package command runs npm pack against an explicit source inventory
in a temporary staging directory. No user npm configuration, lifecycle script,
package fetch, registry publication or server deployment is required. It refuses
to overwrite an existing destination and reports the archive SHA-256. The
archive contains `RELEASE-MANIFEST.json`, with an explicit per-file SHA-256 and
size for the package sources excluding the manifest itself. The manifest and
archive checksum are not signatures. The source list deliberately excludes data,
configuration secrets, local access codes, database artifacts, browser
binaries and dependency directories. Two builds from identical bytes and the
same toolchain should compare byte for byte; CI verifies this and runs startup
from the extracted source. Maintain `scripts/release-files.json` when adding
runtime, documentation, or test files that need to ship.

## Run the full browser suite

This is developer verification, not an application runtime dependency:

```sh
npm --prefix scripts/browser-tools ci --ignore-scripts --no-audit --no-fund
npm run test:browser
```

The browser tool lock pins Playwright, axe-core and a Linux Chromium build.
The prebuilt Chromium path is intended for Linux x64/ARM64 runners with
compatible system libraries. On another supported desktop platform, set
`CHROMIUM_PATH` to the absolute path of a separately installed Chromium
executable. Engine behavior may differ from the pinned CI binary. The test
runner creates its own browser temp directory. A fresh tooling install
requires Internet access; the application and packaged startup do not.
`npm test` without browser opt-in runs Node and HTTP tests only. The
verification workflow has read-only repository permissions, a time limit, no
secrets and no deployment or publishing steps.
