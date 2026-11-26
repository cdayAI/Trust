'use strict';
const required = [22, 13, 0];
function checkRuntime({ sqlite = false, version = process.versions.node } = {}) {
    const bits = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version)?.slice(1).map(Number);
    const firstDifference = bits?.findIndex((value, i) => value !== required[i]);
    if (!bits || (firstDifference !== undefined && firstDifference !== -1 && bits[firstDifference] < required[firstDifference])) {
        throw new Error('Node.js 22.13.0 or newer is required. Found ' + version + '.');
    }
    if (typeof fetch !== 'function' || typeof structuredClone !== 'function' || typeof AbortSignal.timeout !== 'function') {
        throw new Error('This Node.js build is missing a required web API.');
    }
    const report = { node: version, platform: process.platform, architecture: process.arch };
    if (sqlite) {
        try {
            const driver = require('../storage-driver');
            report.sqlite = driver.probeStorageDriver();
        }
        catch (error) {
            throw new Error('This Node.js installation cannot run SQLite mode: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    return report;
}
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length > 1 || (args.length === 1 && args[0] !== '--sqlite')) {
            throw new Error('Usage: node scripts/runtime-check.js [--sqlite]');
        }
        console.log(JSON.stringify(checkRuntime({ sqlite: args.includes('--sqlite') })));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
module.exports = { checkRuntime };
