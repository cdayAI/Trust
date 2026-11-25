'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {dirname, join} = require('node:path');
const {test} = require('node:test');
const {createOperations} = require('../operational-health');

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'trust-operations-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

function launch(t, script, dir, settings = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: join(__dirname, '..'),
    env: {...process.env, TMPDIR: dir, PORT: '0', DATA_FILE: join(dir, 'data', 'state.json'), ...settings},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return closed;
  }
  const started = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', data => {
      stdout += data;
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) resolve(url);
    });
    closed.then(() => reject(new Error('Workbench exited before listening.')), reject);
  });
  // Startup-failure tests only await the exit result.
  started.catch(() => {});
  t.after(stop);
  return {
    started, stop, closed,
    events: () => stderr.trim().split('\n').map(line => JSON.parse(line)),
  };
}

function assertEvents(events, expected) {
  assert.deepEqual(events.map(({event}) => event), expected);
  for (const {at, schemaVersion, event, checks, ...extra} of events) {
    assert.equal(new Date(at).toISOString(), at);
    assert.equal(schemaVersion, 1);
    assert.deepEqual(extra, {});
    if (event === 'readiness_passed' || event === 'readiness_failed') {
      assert.deepEqual(Object.keys(checks).sort(), ['configuration', 'storage']);
      assert.ok(Object.values(checks).every(value => typeof value === 'boolean'));
    } else {
      assert.equal(checks, undefined);
    }
  }
}

async function assertHealth(url, expectedStatus, expectedBody) {
  const response = await fetch(url, {signal: AbortSignal.timeout(3000)});
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), expectedBody);
}

const live = {status: 'live'};
const ready = {status: 'ready', checks: {configuration: true, storage: true}};
const storageUnavailable = {status: 'not_ready', checks: {configuration: true, storage: false}};

test('demo launcher reports storage loss and recovery while staying live', {timeout: 10000}, async t => {
  const dir = await scratch(t);
  const workbench = launch(t, 'server.js', dir);
  const url = await workbench.started;
  const data = join(dir, 'data');
  const snapshot = join(data, 'state.json');
  const before = await readFile(snapshot, 'utf8');
  assert.equal((await fetch(url)).status, 200);
  await assertHealth(url + '/health/live', 200, live);
  await Promise.all(Array.from({length: 4}, () => assertHealth(url + '/health/ready', 200, ready)));
  assert.deepEqual(await readdir(data), ['state.json']);
  assert.equal((await fetch(url + '/health/ready?unused=1')).status, 404);
  const unsupported = await fetch(url + '/health/ready', {method: 'POST'});
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');

  const backup = join(dir, 'saved-data');
  await rename(data, backup);
  await assertHealth(url + '/health/live', 200, live);
  await assertHealth(url + '/health/ready', 503, storageUnavailable);
  await assertHealth(url + '/health/ready', 503, storageUnavailable);
  await rename(backup, data);
  await assertHealth(url + '/health/ready', 200, ready);
  assert.equal(await readFile(snapshot, 'utf8'), before);
  assert.deepEqual(await readdir(data), ['state.json']);

  await writeFile(snapshot + '.workflows', 'synthetic-error-marker');
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url + '/api/workflows/audit');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {error: 'Server error.'});
  }
  assert.deepEqual(await workbench.stop(), [0, null]);
  assertEvents(workbench.events(), [
    'listener_started', 'readiness_passed', 'readiness_failed', 'readiness_passed', 'request_failed', 'listener_stopped'
  ]);
  assert.deepEqual(workbench.events()[2].checks, storageUnavailable.checks);
});

test('isolated launcher probes each provisioned workspace before sign-in', {timeout: 10000}, async t => {
  const dir = await scratch(t);
  const workbench = launch(t, 'start-isolated.js', dir);
  const url = await workbench.started;
  const roots = (await readdir(dir)).filter(name => name.startsWith('trust-synthetic-'));
  assert.equal(roots.length, 1);
  const [root] = roots;
  const workspaces = join(dir, root, 'workspaces');
  const orchard = join(workspaces, 'orchard');
  await assertHealth(url + '/health/ready', 200, ready);
  assert.deepEqual(await readdir(orchard), []);
  assert.deepEqual(await readdir(join(workspaces, 'harbor')), []);
  const missing = join(workspaces, 'temporarily-unavailable');
  await rename(orchard, missing);
  await assertHealth(url + '/health/ready', 503, storageUnavailable);
  await assertHealth(url + '/health/live', 200, live);
  const session = await fetch(url + '/api/session');
  assert.equal((await session.json()).authenticated, false);
  await rename(missing, orchard);
  await assertHealth(url + '/health/ready', 200, ready);
  assert.deepEqual(await workbench.stop(), [0, null]);
  assertEvents(workbench.events(), [
    'listener_started', 'readiness_passed', 'readiness_failed', 'readiness_passed', 'listener_stopped'
  ]);
});

test('invalid launcher configuration reports a fixed event and exits before opening storage', async t => {
  const dir = await scratch(t);
  const workbench = launch(t, 'server.js', dir, {PORT: 'synthetic-invalid-port'});
  assert.deepEqual(await workbench.closed, [1, null]);
  assertEvents(workbench.events(), ['invalid_port']);
  assert.equal((await readdir(dir)).includes('data'), false);
});

test('misspelled isolated security flags fail closed before creating codes or storage', async t => {
  const dir = await scratch(t);
  for (const key of [
    'TRUST_ENABLE_LOCAL_IDENTITY_ADMIN', 'TRUST_ENABLE_LOCAL_DIRECTORY_LIFECYCLE',
    'TRUST_ENABLE_LOCAL_GROUP_GOVERNANCE', 'TRUST_ENABLE_LOCAL_RECORD_SCOPE',
    'TRUST_ENABLE_LOCAL_RIGHTS_CASE_SCOPE', 'TRUST_ENABLE_LOCAL_DOCUMENT_REVIEW_SEAT',
  ]) {
    const workbench = launch(t, 'start-isolated.js', dir, {[key]: 'true'});
    assert.deepEqual(await workbench.closed, [1, null], key);
    assertEvents(workbench.events(), ['startup_failed']);
    assert.deepEqual(await readdir(dir), [], key);
  }
  const workbench = launch(t, 'start-isolated.js', dir, {TRUST_ENABLE_LOCAL_RECORD_SCOPE: '0'});
  await workbench.started;
  assert.deepEqual(await workbench.stop(), [0, null]);
});

test('document-review opt-in launches a distinct seat with only assigned-policy navigation', async t => {
  const dir = await scratch(t);
  const workbench = launch(t, 'start-isolated.js', dir, {
    TEMP: dir, TMP: dir, TRUST_ENABLE_LOCAL_DOCUMENT_REVIEW_SEAT: '1',
  });
  const url = await workbench.started;
  const saved = (await readdir(dir)).filter(name => name.startsWith('trust-synthetic-'));
  assert.equal(saved.length, 1);
  const accounts = JSON.parse(await readFile(join(dir, saved[0], 'local-access.json'), 'utf8'));
  const seat = accounts.find(row => row.id === 'sample-document-reviewer');
  assert.ok(seat);
  const login = await fetch(url+'/api/session/login', {
    method:'POST', headers:{Origin:url,'Content-Type':'application/json'},
    body:JSON.stringify({account:seat.id,workspace:'harbor',code:seat.code}),
  });
  assert.equal(login.status, 200);
  const session = await login.json(), headers = {Cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.deepEqual(session.capabilities.views, ['governance-docs']);
  const queue = await fetch(url+'/api/work-queue?workspace=harbor',{headers});
  assert.equal(queue.status,403);
  const docs = await fetch(url+'/api/governance-documents?workspace=harbor',{headers});
  assert.equal(docs.status,200);
  assert.deepEqual((await docs.json()).documents,[]);
  assert.deepEqual(await workbench.stop(),[0,null]);
});

test('configuration readiness checks the loopback listener and readable workbench assets', async t => {
  const dir = await scratch(t);
  const asset = join(dir, 'asset');
  const snapshot = join(dir, 'data', 'state.json');
  await mkdir(dirname(snapshot));
  const operations = createOperations({files: [snapshot], assets: [asset]});
  const address = {address: '127.0.0.1'};
  const configurationUnavailable = {status: 'not_ready', checks: {configuration: false, storage: true}};
  assert.deepEqual(await operations.ready(address), configurationUnavailable);
  await writeFile(asset, 'synthetic asset');
  assert.deepEqual(await operations.ready(undefined), configurationUnavailable);
  assert.deepEqual(await operations.ready(address), ready);
});
