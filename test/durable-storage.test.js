'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm, readFile, writeFile, stat, mkdir, symlink, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { createServer } = require('../server');
const { openSqlite } = require('../durable-storage');
const { codeHash } = require('../workspace-access');

const source = resolve(__dirname, '..');
const states = { draft: 'Draft', approved: 'Approved' };
const definition = { id: 'storage-sample', initial: 'draft', states: Object.entries(states).map(([id, label]) => ({ id, label })),
  transitions: [{ id: 'finish', from: 'draft', to: 'approved', roles: ['reviewer'], independent: true }] };
const policy = () => ({ schemaVersion: 1, definitions: [], instances: [], events: [] });
const header = (actor, extras) => ({ 'Content-Type': 'application/json', 'X-Demo-Actor': actor, ...extras });
const get = (url, route, headers) => fetch(url + route, { headers });
const post = (url, route, body, actor, extras) => fetch(url + route, { method: 'POST', headers: header(actor, extras), body: JSON.stringify(body) });

async function serverAt(t, options) {
  const server = createServer(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stop = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(stop);
  return { url: 'http://127.0.0.1:' + server.address().port, stop };
}

async function childServer(t, dataFile, sqliteFile) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: source, env: { ...process.env, PORT: '0', DATA_FILE: dataFile, TRUST_SQLITE_FILE: sqliteFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  };
  t.after(stop);
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start.')), 10000);
    lines.once('line', line => {
      clearTimeout(timer);
      resolve(line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(Buffer.concat(stderr).toString('utf8') || 'Server exited.'));
    });
  });
  assert.ok(url);
  return { url, stop };
}

function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, ['storage-cli.js', ...args], {
    cwd: source, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, expected, result.stderr || result.error?.message || result.stdout);
  return expected ? result.stderr : JSON.parse(result.stdout);
}

test('SQLite rollback preserves the last committed data; unrecognized and wrong-mode stores fail closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trust-storage-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'trust.sqlite');
  const db = openSqlite(file);
  try {
    db.requireMode('demo');
    assert.throws(() => db.requireMode('isolated'), /workbench mode/);
    assert.throws(() => db.scope('workspace:alpha'), /workbench mode/);
    const handle = db.scope('demo');
    handle.write('workflow', (_previous, save) => save(policy()));
    assert.throws(() => handle.write('workflow', (_previous, save) => {
      save({ ...policy(), definitions: [definition] });
      throw new Error('Simulated write failure');
    }), /Simulated write failure/);
    assert.deepEqual(handle.read('workflow'), policy());
    assert.equal(db.snapshot().documents[0].generation, 1);
    assert.throws(() => handle.write('workflow', (_previous, save) => save({ schemaVersion: 2 })), /Invalid|Unsupported/);
    assert.throws(() => handle.write('workflow', () => Promise.resolve('bad')), /synchronous/);
    assert.equal(db.snapshot().documents[0].generation, 1);
  } finally { db.close(); }
  const malformed = join(dir, 'malformed.sqlite');
  await writeFile(malformed, 'not a database', { mode: 0o600 });
  assert.throws(() => openSqlite(malformed), /database/);
  const future = join(dir, 'future.sqlite');
  const fresh = openSqlite(future);
  fresh.close();
  const db2 = new (require('node:sqlite').DatabaseSync)(future);
  db2.exec('PRAGMA user_version = 2');
  db2.close();
  assert.throws(() => openSqlite(future), /unsupported/);
  assert.throws(() => createServer({ sqliteFile: file, isolated: {
    root: join(dir, 'scope'), workspaces: [{ id: 'alpha', label: 'Alpha' }],
    accounts: [{ id: 'person', codeHash: codeHash('m'.repeat(43)), memberships: { alpha: 'analyst' } }],
  } }), /workbench mode/);
});

test('two process writers preserve all changes; engine state and audit survive restart and verified restore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trust-storage-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sqlite = join(dir, 'trust.sqlite');
  const legacy = join(dir, 'old.json');
  const first = await childServer(t, legacy, sqlite);
  const second = await childServer(t, legacy, sqlite);
  const actions = Array.from({ length: 20 }, (_, i) =>
    post(i % 2 ? first.url : second.url, '/api/projects', { name: 'Synthetic project ' + i }, 'analyst'));
  assert.ok((await Promise.all(actions)).every(r => r.status === 200));
  const current = await (await get(first.url, '/api/state')).json();
  assert.equal(current.projects.length, 21);
  assert.equal(new Set(current.projects.map(p => p.id)).size, 21);
  assert.equal(current.audit.filter(e => e.action === 'project.created').length, 21);
  const workflow = '/api/workflows/definitions';
  const r = await Promise.all([first, second].map(s => post(s.url, workflow, { definition, expectedVersion: 0 }, 'publisher')));
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  const published = await (await get(first.url, workflow + '/storage-sample')).json();
  assert.equal(published.version, 1);
  const audit = await (await get(second.url, '/api/workflows/audit')).json();
  assert.deepEqual(audit.audit.map(e => e.outcome), ['accepted', 'refused']);
  const bad = await post(first.url, '/api/assessments/' + current.assessments[0].id + '/save',
    { expectedRevision: 999, summary: 'Not committed' }, 'analyst');
  assert.equal(bad.status, 409);
  const refused = await (await get(second.url, '/api/state')).json();
  assert.equal(refused.audit.at(-1).action, 'assessment.refused');
  assert.equal(refused.assessments[0].answers.summary, '');
  await assert.rejects(access(legacy), { code: 'ENOENT' });
  const backup = join(dir, 'backup.json');
  const file = await cli(['backup', sqlite, backup]);
  assert.deepEqual(cli(['verify', backup]), file);
  assert.equal(file.mode, 'demo');
  assert.equal(file.documents, 2);
  if (process.platform !== 'win32') {
    assert.equal((await stat(sqlite)).mode & 0o777, 0o600);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
  }
  await first.stop(); await second.stop();
  const restoredPath = join(dir, 'restored.sqlite');
  assert.deepEqual(cli(['restore', backup, restoredPath]), { mode: 'demo', documents: 2 });
  assert.match(cli(['restore', backup, restoredPath], 1), /already exists|EEXIST/i);
  assert.match(cli(['backup', sqlite, backup], 1), /already exists|EEXIST/i);
  const restored = await serverAt(t, { sqliteFile: restoredPath, dataFile: legacy });
  assert.deepEqual(await (await get(restored.url, '/api/state')).json(), refused);
  assert.deepEqual(await (await get(restored.url, '/api/workflows/audit')).json(), audit);
  const corrupt = join(dir, 'corrupt.json');
  const changed = JSON.parse(await readFile(backup, 'utf8'));
  changed.documents[0].payload.projects[0].name = 'Tampered';
  await writeFile(corrupt, JSON.stringify(changed));
  const noFile = join(dir, 'not-restored.sqlite');
  assert.match(cli(['verify', corrupt], 1), /checksum/);
  assert.match(cli(['restore', corrupt, noFile], 1), /checksum/);
  await assert.rejects(access(noFile), { code: 'ENOENT' });
});

test('explicit JSON migration preserves both snapshots and original bytes; isolated restores preserve tenant boundaries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trust-storage-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacyFile = join(dir, 'demo.json');
  const json = await serverAt(t, { dataFile: legacyFile });
  await post(json.url, '/api/projects', { name: 'Legacy demo project' }, 'analyst');
  await post(json.url, '/api/workflows/definitions', { definition, expectedVersion: 0 }, 'publisher');
  await json.stop();
  const oldState = await readFile(legacyFile);
  const oldWorkflow = await readFile(legacyFile + '.workflows');
  const sqliteFile = join(dir, 'demo.sqlite');
  assert.throws(() => createServer({ dataFile: legacyFile, sqliteFile: join(dir, 'blocked.sqlite') }), /migrate it explicitly/);
  assert.deepEqual(cli(['migrate', legacyFile, sqliteFile]), { mode: 'demo', documents: 2 });
  assert.deepEqual(await readFile(legacyFile), oldState);
  assert.deepEqual(await readFile(legacyFile + '.workflows'), oldWorkflow);
  const migrated = await serverAt(t, { dataFile: legacyFile, sqliteFile });
  assert.deepEqual(await (await get(migrated.url, '/api/state')).json(), JSON.parse(oldState));
  assert.equal((await (await get(migrated.url, '/api/workflows/definitions/storage-sample')).json()).version, 1);

  const root = join(dir, 'workspaces');
  const code = 'm'.repeat(43);
  const isolated = { root, workspaces: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }],
    accounts: [{ id: 'person', codeHash: codeHash(code), memberships: { alpha: 'analyst', beta: 'analyst' } }] };
  const isolatedLegacy = await serverAt(t, { isolated });
  async function login(url, workspace) {
    const r = await post(url, '/api/session/login', { account: 'person', workspace, code }, undefined, { Origin: url });
    assert.equal(r.status, 200);
    return { Cookie: r.headers.get('set-cookie').split(';')[0], Origin: url };
  }
  const scoped = '/api/projects?workspace=alpha';
  const oldSession = await login(isolatedLegacy.url, 'alpha');
  assert.equal((await post(isolatedLegacy.url, scoped, { name: 'Alpha only' }, undefined, oldSession)).status, 200);
  await isolatedLegacy.stop();
  const oldAlpha = await readFile(join(root, 'alpha', 'state.json'));
  const db = join(dir, 'isolated.sqlite');
  assert.deepEqual(cli(['migrate-isolated', root, db]), { mode: 'isolated', documents: 1 });
  assert.deepEqual(await readFile(join(root, 'alpha', 'state.json')), oldAlpha);
  const backup = join(dir, 'isolated-backup.json');
  cli(['backup', db, backup]);
  const restoredPath = join(dir, 'isolated-restore.sqlite');
  cli(['restore', backup, restoredPath]);
  const restored = await serverAt(t, { isolated, sqliteFile: restoredPath });
  const alpha = await login(restored.url, 'alpha');
  const beta = await login(restored.url, 'beta');
  assert.equal((await get(restored.url, '/api/state?workspace=alpha', beta)).status, 403);
  assert.deepEqual((await (await get(restored.url, '/api/state?workspace=beta', beta)).json()).projects, []);
  assert.equal((await (await get(restored.url, '/api/state?workspace=alpha', alpha)).json()).projects[0].name, 'Alpha only');
  assert.equal((await post(restored.url, '/api/projects?workspace=beta', { name: 'Beta only' }, undefined, beta)).status, 200);
  await assert.rejects(access(join(root, 'beta', 'state.json')), { code: 'ENOENT' });
  assert.throws(() => createServer({ dataFile: legacyFile, sqliteFile: db }), /workbench mode/);

  await mkdir(join(root, 'extra'));
  await symlink(legacyFile, join(root, 'extra', 'state.json'));
  assert.match(cli(['migrate-isolated', root, join(dir, 'out.sqlite')], 1), /single-link regular file/);
  await assert.rejects(access(join(dir, 'out.sqlite')), { code: 'ENOENT' });
});

test('browser smoke: SQLite-backed edits reopen in the UI after server restart', {
  skip: process.env.RUN_BROWSER_SMOKE !== '1' && 'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
  timeout: 30000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trust-storage-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dataFile: join(dir, 'state.json'), sqliteFile: join(dir, 'trust.sqlite') };
  const first = await serverAt(t, options);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(first.url);
    await page.getByLabel('Project name').fill('SQLite browser persistence');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('heading', { name: 'SQLite browser persistence' }).waitFor();
    await first.stop();
    const second = await serverAt(t, options);
    await page.goto(second.url);
    await page.getByRole('button', { name: 'SQLite browser persistence' }).click();
    await page.getByRole('heading', { name: 'SQLite browser persistence' }).waitFor();
    await assert.rejects(access(options.dataFile), { code: 'ENOENT' });
  } finally { await browser.close(); }
});
