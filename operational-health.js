'use strict';
const node_fs_1 = require("node:fs");
const fs = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_perf_hooks_1 = require("node:perf_hooks");
function missing(error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
const loopbackHost = '127.0.0.1';
const loopbackAddresses = new Set([loopbackHost, '::1', '::ffff:127.0.0.1']);
const canaryContents = 'MVW Trust synthetic readiness check\n';
function writeEvent(event, checks) {
    const record = { schemaVersion: 1, at: new Date().toISOString(), event };
    if (checks)
        record.checks = checks;
    process.stderr.write(JSON.stringify(record) + '\n');
}
async function isHealthy(check) {
    try {
        await check();
        return true;
    }
    catch {
        return false;
    }
}
async function checkSnapshotPath(file) {
    let stat;
    try {
        stat = await fs.lstat(file);
    }
    catch (error) {
        if (missing(error))
            return; // A workspace may not have saved yet.
        throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Invalid snapshot path.');
    await fs.access(file, node_fs_1.constants.R_OK);
}
async function checkStorage(directory, originalPath, snapshots) {
    if (await fs.realpath(directory) !== originalPath)
        throw new Error('Storage directory changed.');
    await Promise.all(snapshots.map(checkSnapshotPath));
    const scratch = await fs.mkdtemp((0, node_path_1.join)(directory, '.trust-probe-'));
    try {
        const pending = (0, node_path_1.join)(scratch, 'pending');
        const committed = (0, node_path_1.join)(scratch, 'committed');
        await fs.writeFile(pending, canaryContents, { flag: 'wx', mode: 0o600, flush: true });
        await fs.rename(pending, committed);
        if (await fs.readFile(committed, 'utf8') !== canaryContents)
            throw new Error('Canary mismatch.');
    }
    finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}
function createOperations({ files, assets, logEvents, checkBackend }) {
    const emit = logEvents ? writeEvent : () => { };
    const directories = new Map();
    for (const file of files.map(file => (0, node_path_1.resolve)(file))) {
        const directory = (0, node_path_1.dirname)(file);
        if (!directories.has(directory)) {
            directories.set(directory, { originalPath: (0, node_fs_1.realpathSync)(directory), snapshots: [] });
        }
        directories.get(directory).snapshots.push(file);
    }
    let inFlight;
    let previousChecks;
    let nextRequestError = 0;
    async function measure(address) {
        const [configuration, ...storageResults] = await Promise.all([
            isHealthy(async () => {
                if (!address || typeof address !== 'object' || !('address' in address) || typeof address.address !== 'string' || !loopbackAddresses.has(address.address))
                    throw new Error('Listener is not on loopback.');
                await Promise.all(assets.map(async (file) => {
                    const stat = await fs.stat(file);
                    if (!stat.isFile() || !stat.size)
                        throw new Error('Invalid workbench asset.');
                    await fs.access(file, node_fs_1.constants.R_OK);
                }));
            }),
            ...(checkBackend ? [isHealthy(checkBackend)] : []),
            ...[...directories].map(([directory, { originalPath, snapshots }]) => isHealthy(() => checkStorage(directory, originalPath, snapshots))),
        ]);
        const storage = storageResults.every(Boolean);
        const checks = { configuration, storage };
        if (configuration !== previousChecks?.configuration || storage !== previousChecks?.storage) {
            emit(configuration && storage ? 'readiness_passed' : 'readiness_failed', checks);
            previousChecks = checks;
        }
        return { status: configuration && storage ? 'ready' : 'not_ready', checks };
    }
    return {
        ready(address) {
            inFlight ??= measure(address).finally(() => { inFlight = undefined; });
            return inFlight;
        },
        listening() {
            previousChecks = undefined;
            emit('listener_started');
        },
        stopped() {
            emit('listener_stopped');
        },
        requestError() {
            const now = node_perf_hooks_1.performance.now();
            if (now < nextRequestError)
                return;
            nextRequestError = now + 30_000;
            emit('request_failed');
        },
    };
}
function launchLocalServer(start) {
    try {
        const port = Number(process.env.PORT ?? 4173);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            writeEvent('invalid_port');
            process.exitCode = 1;
            return;
        }
        const { server, onListening } = start();
        server.once('error', () => {
            writeEvent('listener_failed');
            process.exitCode = 1;
        });
        function stop() {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            server.close();
        }
        server.listen(port, loopbackHost, () => {
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            onListening();
        });
    }
    catch {
        writeEvent('startup_failed');
        process.exitCode = 1;
    }
}
module.exports = { createOperations, launchLocalServer, loopbackAddresses };
