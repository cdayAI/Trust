'use strict';

const { spawn } = require('node:child_process');
const { mkdtemp, rm, readdir, appendFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { checkRuntime } = require('./runtime-check');

async function verify() {
  checkRuntime({ sqlite: true });
  const browserModules = join(__dirname, 'browser-tools', 'node_modules');
  const env = { ...process.env, RUN_BROWSER_SMOKE: '1', NODE_PATH: browserModules };
  const test = ['--test', '--test-timeout=60000'];
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
    const cwd = resolve(__dirname, '..');
    const run = args => new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', status => resolveCode(status ?? 1));
    });
    const shard = env.TRUST_QA_SHARD;
    if (shard === undefined) {
      console.log('Running the full suite with browser verification enabled.');
      process.exitCode = await run(test);
    } else {
      if (!/^[0-3]$/.test(shard)) throw new Error('TRUST_QA_SHARD must be 0, 1, 2 or 3.');
      const suites = (await readdir(join(cwd, 'test'))).filter(name => name.endsWith('.test.js')).sort();
      if (!suites.length || suites.length > 100) throw new Error('The 100-pass plan cannot cover the test inventory.');
      let failed = 0;
      const summary = ['| Pass | Test file | Result |', '| ---: | --- | --- |'];
      for (let index = 0; index < 25; index++) {
        const pass = Number(shard) * 25 + index + 1;
        const suite = suites[(pass - 1) % suites.length];
        console.log('::group::Pass ' + pass + '/100: ' + suite);
        const status = await run([...test, join('test', suite)]);
        console.log('::endgroup::');
        if (status !== 0) failed++;
        const line = '| ' + pass + ' | ' + suite + ' | ' + (status === 0 ? 'PASS' : 'FAIL (' + status + ')') + ' |';
        summary.push(line);
        console.log(line);
      }
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
      console.log('Shard ' + shard + ': ' + (25 - failed) + '/25 successful targeted test passes.');
      process.exitCode = failed ? 1 : 0;
    }
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
