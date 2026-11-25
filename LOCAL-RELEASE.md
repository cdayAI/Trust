# Run and verify MVW Trust locally

**Synthetic, unofficial prototype.** Use only fictional records. None of the
commands deploy the application or require a GitHub, Marriott, or cloud account.

## Start the isolated release with SQLite

With Node.js 22.13.0 or newer, open a terminal in the source or the extracted
package. No dependencies are required for this launcher:

```sh
npm run start:release
```

Or run `node ./start-release.js` on macOS/Linux and
`node .\start-release.js` in Windows PowerShell. The launch opens no browser
or public listener. It prints a single JSON result containing the verified
loopback URL, a private access-file path, and a run-directory path. Open the
URL on the **same machine**; open the access file locally and use a synthetic
`staff` account ID, its workspace ID (such as `harbor`), and its generated code.
Do not use a work password or copy the access file into chat, Git, or a shared
drive. The file also contains separate synthetic requester, employee and
learner codes for the local portals at `/requester`, `/employee`, and `/training`.

The launcher checks liveness, SQLite readiness, a real sign-in for each
workspace and cross-workspace denial before announcing the URL. It starts
with two empty fictional workspaces and enables local identity administration,
group and document scope, account-scoped rights delegation, manual attachment
review, the larger-PDF upload profile, staged fictional discovery, reviewed
local directory lifecycle changes, and SQLite-backed operator jobs, along with the supported synthetic
portals. Each launch automatically stops after eight hours. It does not start corporate SSO,
send external communications, or deploy anything. The optional `--port 4173`
selects a specific loopback port; otherwise a free port is chosen. Existing
demo, isolated JSON/SQLite, and corporate sign-in launchers are unchanged.

Workspace data and access files are created in a fresh directory under the
OS temporary directory, never in the source tree. Use your system's private
temporary directory rather than a shared directory or network drive. On Unix
the directory and access file have owner-only permissions; Windows uses the
private temp directory's inherited permissions. Ctrl+C stops the release
and removes the access file on graceful shutdown, leaving the database and
private release profile for resume. Forced termination may leave the access
file behind. Never share the private profile: it can recreate synthetic access
codes and signing keys. Remove the whole run directory after the exercise
unless you intend to resume it.

For an install-free preflight that starts the same app, checks it, and cleans
up without leaving a server or access file, run
`npm run start:release -- --check` or `node start-release.js --check`.

## Resume a stopped synthetic release

Run this from a current source or extracted package. Replace the placeholder
with the exact `runDirectory` from the original startup result:

```sh
npm run start:release -- --resume "/path/to/mvw-trust-release-EXAMPLE"
```

For PowerShell, the equivalent is
`node .\start-release.js --resume "C:\path\to\mvw-trust-release-EXAMPLE"`.
A successful resume reopens the same private SQLite file with a new local
port by default. Sign in again; old browser sessions are not preserved.
Synthetic account codes and receipt-signing keys are regenerated from the
original owner-only profile, so existing account-scoped approvals, requester
receipts, and pending work remain usable. Treat the profile and any regenerated
codes as credentials. A fresh launch without `--resume` still starts empty.

Only a recognized directory made by a resume-capable release can be resumed.
This mode rejects arbitrary SQLite files, mismatched profiles/databases,
unsafe linkage/permissions, and attempts to open a running release again. An OS-released lease prevents two listeners from
sharing the same run; you do not need to delete lock files after interruption.
If startup is refused, existing saved work is not reset. Restore or verify
standalone backups through [backup and recovery](DURABLE-STORAGE.md); a
database-only backup does not carry the synthetic identity profile or migrate
old launches without a profile. This is local restart recovery, not cross-host
disaster recovery or production hosting.

## Other install-free launch modes

Use Node.js 22.13.0 or newer. Node 24.22.3 is the pinned CI toolchain.
The demo and isolated launchers run without `npm install`. The optional
[corporate sign-in mode](CORPORATE-SIGNIN.md) uses its own locked dependencies.
With Node and its normally bundled npm, open a terminal in the source or
extracted archive and run:

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
Optional `TRUST_ENABLE_LOCAL_*` flags accept `1` to enable, `0` to disable,
or no setting. Other values stop the isolated launcher before it opens a
listener or creates any access codes.

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
node start-release.js --check
```

On Windows PowerShell, use `tar.exe -xzf .\dist\mvw-trust.tgz -C C:\path\to\private-folder`
and run the verification from the extracted `package` directory.

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
