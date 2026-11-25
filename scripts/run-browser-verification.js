'use strict';

const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { checkRuntime } = require('./runtime-check');

async function verify() {
  checkRuntime({ sqlite: true });
  const browserModules = join(__dirname, 'browser-tools', 'node_modules');
  const env = { ...process.env, RUN_BROWSER_SMOKE: '1', NODE_PATH: browserModules };
  // Several suites spawn Chromium. Bound parallel workers so low-CPU CI
  // runners measure the application instead of starving browser processes.
  const test = ['--test', '--test-concurrency=4', '--test-timeout=90000'];
  // Keep a caller's explicitly opted-in browser binary. The locked bundled
  // Chromium in CI is a Linux x64/ARM64 build, not a desktop installer.
  if (env.CHROMIUM_PATH) {
    if (!isAbsolute(env.CHROMIUM_PATH)) throw new Error('CHROMIUM_PATH must be an absolute local executable location.');
  } else if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Provide CHROMIUM_PATH for an installed desktop Chromium on this platform.');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'mvw-trust-chromium-'));
  const previousTmpdir = process.env.TMPDIR;
  try {
    require.resolve('playwright', { paths: [browserModules] });
    require.resolve('axe-core', { paths: [browserModules] });
    if (!env.CHROMIUM_PATH) {
      // Load the optional browser binary without changing the application
      // dependency graph or inheriting a previous /tmp/chromium binary.
      process.env.TMPDIR = scratch;
      const modulePath = require.resolve('@sparticuz/chromium', { paths: [browserModules] });
      const { default: chromium } = await import(pathToFileURL(modulePath).href);
      env.CHROMIUM_PATH = await chromium.executablePath();
    }
    console.log('Running the full suite with browser verification enabled.');
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, test, { cwd: resolve(__dirname, '..'), env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', status => resolveCode(status ?? 1));
    });
    process.exitCode = code;
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(scratch, { recursive: true, force: true });
  }
}

verify().catch(error => {
  console.error('Browser verification failed: ' + error.message);
  process.exitCode = 1;
});
