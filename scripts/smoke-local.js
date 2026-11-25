'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { checkRuntime } = require('./runtime-check');

const appRoot = resolve(__dirname, '..');
const startupTimeout = 12000;
const operationTimeout = 6000;
const hostFields = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LD_LIBRARY_PATH'];
const host = Object.fromEntries(hostFields.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

function run(script, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: appRoot, env: { ...host, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Attach a rejection handler immediately; a process may fail before a caller
  // starts awaiting its startup event.
  exited.catch(() => {});
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, 2500);
    try { await exited; } finally { clearTimeout(killer); }
  }
  return { child, exited, stop, output: () => stdout, error: () => stderr };
}

async function launcher(script, env, validate) {
  const process = run(script, { ...env, PORT: '0' });
  let timer;
  let onData;
  try {
    const ready = new Promise((resolve, reject) => {
      onData = () => {
        const output = process.output();
        const url = /http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}/.exec(output)?.[0];
        if (url && (script !== 'start-isolated.js' || /Local employee access file.+\n/.test(output))) resolve({ url, output });
      };
      process.child.stdout.on('data', onData);
      onData();
      timer = setTimeout(() => reject(new Error(script + ' did not announce a loopback port.')), startupTimeout);
    });
    const launch = await Promise.race([
      ready,
      process.exited.then(() => { throw new Error(script + ' exited before startup. ' + process.error()); }),
    ]);
    await validate(launch);
  } finally {
    clearTimeout(timer);
    if (onData) process.child.stdout.removeListener('data', onData);
    await process.stop();
  }
}

async function expect(url, route, code, options = {}) {
  const response = await fetch(url + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(operationTimeout) });
  assert.equal(response.status, code, route);
  return response;
}

function request(url, body, headers = {}) {
  return { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(body) };
}

async function demoSmoke(env, { restored = false, afterChecks } = {}) {
  const savedName = 'Synthetic operational verification project';
  await launcher('server.js', env, async ({ url }) => {
    const html = await expect(url, '/', 200);
    assert.match(await html.text(), /MVW Trust/);
    assert.equal((await (await expect(url, '/api/session', 200)).json()).mode, 'synthetic-demo');
    const state = await (await expect(url, '/api/state', 200)).json();
    assert.ok(state.projects.some(project => project.id === 'demo-project'));
    if (!restored) {
      await expect(url, '/api/projects', 200, request(url, { name: savedName }, { 'X-Demo-Actor': 'analyst' }));
    }
    const after = await (await expect(url, '/api/state', 200)).json();
    assert.equal(after.projects.filter(project => project.name === savedName).length, 1);
    assert.ok(after.audit.some(event => event.action === 'project.created' && event.details.name === savedName));
    await afterChecks?.();
  });
}

async function isolatedSmoke(env) {
  await launcher('start-isolated.js', env, async ({ url, output }) => {
    const accountPath = /^Local test access file \(private; contains generated codes\): (.+)$/m.exec(output)?.[1]?.trim();
    assert.ok(accountPath, 'The launcher must make generated local access available.');
    const accounts = JSON.parse(await readFile(accountPath, 'utf8'));
    const { id, code } = accounts.find(account => account.id === 'sample-intake');
    assert.equal((await (await expect(url, '/api/session', 200)).json()).authenticated, false);
    await expect(url, '/api/state?workspace=harbor', 401);
    const login = await expect(url, '/api/session/login', 200, request(url, { account: id, code, workspace: 'harbor' }));
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('trust_local_session='));
    const headers = { Cookie: cookie };
    const created = 'Synthetic isolated operational verification project';
    await expect(url, '/api/projects?workspace=harbor', 200, request(url, { name: created }, headers));
    const harbor = await (await expect(url, '/api/state?workspace=harbor', 200, { headers })).json();
    assert.deepEqual(harbor.projects.map(project => project.name), [created]);
    await expect(url, '/api/state?workspace=orchard', 403, { headers });
    await expect(url, '/api/session/logout', 200, request(url, {}, headers));
    await expect(url, '/api/state?workspace=harbor', 401, { headers });
  });
}

async function storageCommand(env, ...args) {
  const running = run('storage-cli.js', env, args);
  let timer;
  try {
    const { code } = await Promise.race([running.exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Storage verification command timed out.')), startupTimeout);
    })]);
    assert.equal(code, 0, running.error());
    return JSON.parse(running.output());
  } finally { clearTimeout(timer); await running.stop(); }
}

async function runSmoke({ sqlite }) {
  const runtime = checkRuntime({ sqlite });
  const room = await mkdtemp(join(tmpdir(), 'mvw-trust-operational-smoke-'));
  const temp = { TMPDIR: room, TMP: room, TEMP: room };
  const checks = [];
  try {
    await demoSmoke({ ...temp, DATA_FILE: join(room, 'demo.json') });
    checks.push('demo launch and persistent project');
    await isolatedSmoke(temp);
    checks.push('isolated launch, sign-in, and workspace boundaries');
    if (sqlite) {
      const database = join(room, 'original.sqlite');
      const backup = join(room, 'sample.trust-backup.json');
      const restored = join(room, 'restored.sqlite');
      const legacy = join(room, 'no-existing-legacy.json');
      let result;
      await demoSmoke({ ...temp, DATA_FILE: legacy, TRUST_SQLITE_FILE: database }, {
        afterChecks: async () => { result = await storageCommand(temp, 'backup', database, backup); },
      });
      assert.equal(result.documents, 1);
      assert.deepEqual(await storageCommand(temp, 'verify', backup), result);
      assert.deepEqual(await storageCommand(temp, 'restore', backup, restored), { mode: 'demo', documents: 1 });
      await demoSmoke({ ...temp, DATA_FILE: legacy, TRUST_SQLITE_FILE: restored }, { restored: true });
      await isolatedSmoke({ ...temp, TRUST_SQLITE_FILE: join(room, 'isolated.sqlite') });
      checks.push('SQLite online backup, checksum verification, and restored HTTP state', 'isolated SQLite launch');
    }
    return { runtime, checks };
  } finally {
    await rm(room, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--sqlite')) {
    console.error('Usage: node scripts/smoke-local.js [--sqlite]');
    process.exitCode = 1;
  } else {
    runSmoke({ sqlite: args.includes('--sqlite') }).then(report => console.log(JSON.stringify(report, null, 2)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
module.exports = { runSmoke };
