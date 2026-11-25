'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const root = resolve(__dirname, '..');
const jobs = '/api/operator/v1/jobs';
const rights = '/api/rights/cases';
const auditPath = '/api/audit/export';
const harbor = path => path + '?workspace=harbor';

async function launch(t, sqliteFile, entry = 'start-isolated.js') {
  const env = { ...process.env, PORT: '0', TRUST_ENABLE_LOCAL_IDENTITY_ADMIN: '1' };
  delete env.DATA_FILE;
  delete env.TRUST_SQLITE_FILE;
  if (sqliteFile) env.TRUST_SQLITE_FILE = sqliteFile;
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let access;
  let url;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    if (access) await rm(dirname(access), { recursive: true, force: true });
  };
  t.after(stop);
  const lines = createInterface({ input: child.stdout });
  await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('Local Trust did not start. ' + stderr)), 10000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', () => { clearTimeout(timer); fail(new Error('Local Trust exited. ' + stderr)); });
    lines.on('line', line => {
      url ??= line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      const prefix = 'Local test access file (private; contains generated codes): ';
      if (line.startsWith(prefix)) access = line.slice(prefix.length);
      if (url && (access || entry === 'server.js')) {
        clearTimeout(timer);
        ready();
      }
    });
  });
  const accounts = access ? JSON.parse(await readFile(access, 'utf8')) : [];
  async function call(path, { cookie, body, headers = {} } = {}) {
    const requestHeaders = {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { Origin: url, 'Content-Type': 'application/json' }),
      ...headers,
    };
    const response = await fetch(url + path, {
      headers: requestHeaders,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  async function login(account, workspace = 'harbor') {
    const code = accounts.find(row => row.id === account).code;
    const response = await call('/api/session/login', { body: { account, code, workspace } });
    assert.equal(response.status, 200);
    return response.cookie.split(';')[0];
  }
  return { call, login, stop };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'trust-operator-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'test.sqlite');
}

function status(response, expected, code) {
  assert.equal(response.status, expected, JSON.stringify(response.data));
  if (code) assert.equal(response.data.code, code);
  return response.data;
}

function assign(caseId) {
  return { action: 'rights.case.assign', args: { caseId, expectedRevision: 1 }, idempotencyKey: randomUUID() };
}

async function openCase(server, cookie) {
  const opened = await server.call(harbor(rights), {
    cookie, body: { kind: 'access', owner: 'analyst', days: 30, note: 'Fictional rights intake.' },
  });
  return status(opened, 200).cases[0];
}

test('operator API is available only in isolated SQLite mode', async t => {
  const file = await fixture(t);
  const isolatedJson = await launch(t);
  const analyst = await isolatedJson.login('sample-intake');
  status(await isolatedJson.call(harbor(jobs), { cookie: analyst }), 404);
  const sqliteDemo = await launch(t, file, 'server.js');
  status(await sqliteDemo.call(harbor(jobs), { headers: { 'X-Demo-Actor': 'analyst' } }), 404);
});

test('jobs enforce isolated roles, keep durable state, and commit rights and audit atomically', async t => {
  const sqlite = await fixture(t);
  const first = await launch(t, sqlite);
  const second = await launch(t, sqlite);
  const analyst = await first.login('sample-intake');
  const analyst2 = await second.login('sample-intake');
  const reviewer = await first.login('sample-review');
  const publisher = await first.login('sample-publisher');
  const caseOperator = await first.login('sample-case-operator');
  const admin = await first.login('sample-identity-admin');
  const otherWorkspace = await first.login('sample-orchard', 'orchard');
  const record = await openCase(first, analyst);
  const proposal = assign(record.id);
  const otherArgs = { expectedRevision: 1, caseId: record.id };

  status(await first.call(harbor(jobs)), 401);
  for (const cookie of [publisher, caseOperator, admin]) status(await first.call(harbor(jobs), { cookie }), 403, 'ACCESS_DENIED');
  status(await first.call(jobs + '?workspace=harbor&workspace=orchard', { cookie: analyst }), 403);
  status(await first.call(harbor(jobs) + '&filter=all', { cookie: analyst }), 422);
  status(await first.call(harbor(jobs), { cookie: analyst, body: proposal, headers: { Origin: 'http://localhost:1' } }), 403);
  status(await first.call(harbor(jobs), { cookie: analyst, body: { ...proposal, action: 'rights.case.fulfill' } }), 422, 'UNKNOWN_JOB_ACTION');
  status(await first.call(harbor(jobs), { cookie: analyst, body: { ...proposal, idempotencyKey: 'user supplied label' } }), 422, 'INVALID_JOB_INPUT');
  status(await first.call(harbor(jobs), { cookie: analyst, body: { ...proposal, correlationId: randomUUID() } }), 422, 'INVALID_JOB_INPUT');
  status(await first.call(harbor(jobs), { cookie: reviewer, body: proposal }), 403, 'ACCESS_DENIED');

  const submissions = await Promise.all([
    first.call(harbor(jobs), { cookie: analyst, body: proposal }),
    second.call(harbor(jobs), { cookie: analyst2, body: { ...proposal, args: otherArgs } }),
  ]);
  assert.deepEqual(submissions.map(response => response.status).sort(), [200, 201]);
  assert.deepEqual(submissions[0].data, submissions[1].data);
  const pending = submissions[0].data.job;
  assert.equal(pending.status, 'awaiting-approval');
  assert.equal(pending.requestedBy, 'sample-intake');
  const at = (suffix = '') => harbor(jobs + '/' + pending.id + suffix);
  const decision = { decision: 'approve' };
  const getRights = async (server, cookie) => status(await server.call(harbor(rights), { cookie }), 200).cases;
  status(await first.call(harbor(jobs), {
    cookie: analyst, body: { ...proposal, args: { ...proposal.args, expectedRevision: 2 } },
  }), 409, 'IDEMPOTENCY_CONFLICT');
  status(await first.call(jobs + '/' + pending.id + '?workspace=orchard', { cookie: otherWorkspace }), 404, 'JOB_NOT_FOUND');
  status(await first.call(at('/decision'), { cookie: analyst, body: decision, headers: { 'X-Demo-Actor': 'reviewer' } }), 403);
  status(await first.call(at('/run'), { cookie: analyst, body: {} }), 409, 'JOB_NOT_RUNNABLE');
  status(await first.call(at('/run'), { cookie: reviewer, body: {} }), 404, 'JOB_NOT_FOUND');
  assert.deepEqual(status(await first.call(harbor(jobs), { cookie: reviewer }), 200).jobs, [pending]);
  assert.equal((await getRights(first, reviewer))[0].owner, 'analyst');

  const readProposal = { action: 'rights.case.status', args: { caseId: record.id }, idempotencyKey: proposal.idempotencyKey };
  const readJob = status(await first.call(harbor(jobs), { cookie: reviewer, body: readProposal }), 201).job;
  assert.equal(readJob.status, 'queued');
  assert.notEqual(readJob.id, pending.id);
  const sameAccountElsewhere = await first.login('sample-intake', 'orchard');
  const orchardJob = status(await first.call(jobs + '?workspace=orchard', {
    cookie: sameAccountElsewhere, body: readProposal,
  }), 201).job;
  assert.notEqual(orchardJob.id, pending.id);
  const missing = status(await first.call(jobs + '/' + orchardJob.id + '/run?workspace=orchard', {
    cookie: sameAccountElsewhere, body: {},
  }), 200).job;
  assert.equal(missing.status, 'failed');
  assert.deepEqual(missing.failure, { code: 'CASE_NOT_FOUND' });
  status(await first.call(harbor(jobs + '/' + readJob.id), { cookie: analyst }), 404, 'JOB_NOT_FOUND');
  status(await first.call(harbor(jobs + '/' + readJob.id + '/decision'), { cookie: reviewer, body: decision }), 404, 'JOB_NOT_FOUND');

  const approved = status(await first.call(at('/decision'), { cookie: reviewer, body: decision }), 200).job;
  assert.equal(approved.status, 'queued');
  assert.equal(approved.decision.by, 'sample-review');
  assert.equal((await getRights(first, reviewer))[0].revision, 1);
  status(await first.call(harbor('/api/identity-admin'), {
    cookie: admin, body: { target: 'sample-intake', operation: 'revoke', reason: 'session-reset', expectedRevision: 0 },
  }), 200);
  status(await second.call(at('/run'), { cookie: analyst2, body: {} }), 401);
  assert.deepEqual(status(await first.call(at(), { cookie: reviewer }), 200).job, approved);
  await first.stop();
  await second.stop();

  const resumed = await launch(t, sqlite);
  const resumedAnalyst = await resumed.login('sample-intake');
  const resumedReviewer = await resumed.login('sample-review');
  assert.deepEqual(status(await resumed.call(at(), { cookie: resumedAnalyst }), 200).job, approved);
  assert.deepEqual(status(await resumed.call(at('/decision'), { cookie: resumedReviewer, body: decision }), 200).job, approved);
  assert.deepEqual(status(await resumed.call(harbor(jobs + '/' + readJob.id), { cookie: resumedReviewer }), 200).job, readJob);
  const read = status(await resumed.call(harbor(jobs + '/' + readJob.id + '/run'), { cookie: resumedReviewer, body: {} }), 200).job;
  assert.deepEqual(read.result, { caseId: record.id, kind: 'access', owner: 'analyst', status: 'received', revision: 1 });

  async function audit() {
    const data = status(await resumed.call(harbor(auditPath), { cookie: resumedReviewer }), 200);
    return data.audit.filter(event => event.correlationId === pending.id);
  }

  const db = new DatabaseSync(sqlite);
  try {
    db.exec(`
      CREATE TRIGGER reject_test_write BEFORE UPDATE ON snapshots
      WHEN NEW.scope = 'workspace:harbor' AND NEW.kind = 'workbench'
      BEGIN SELECT RAISE(ABORT, 'Simulated operator write failure'); END;
    `);
    status(await resumed.call(at('/run'), { cookie: resumedAnalyst, body: {} }), 500);
    assert.deepEqual(status(await resumed.call(at(), { cookie: resumedAnalyst }), 200).job, approved);
    assert.equal((await getRights(resumed, resumedReviewer))[0].revision, 1);
    assert.equal((await getRights(resumed, resumedReviewer))[0].owner, 'analyst');
    assert.deepEqual((await audit()).map(event => event.action), ['operator.job.submitted', 'operator.job.approved']);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_test_write');
    db.close();
  }

  const peer = await launch(t, sqlite);
  const peerAnalyst = await peer.login('sample-intake');
  const runs = await Promise.all([
    resumed.call(at('/run'), { cookie: resumedAnalyst, body: {} }),
    peer.call(at('/run'), { cookie: peerAnalyst, body: {} }),
  ]);
  const done = status(runs[0], 200).job;
  assert.deepEqual(status(runs[1], 200).job, done);
  assert.deepEqual(status(await resumed.call(harbor(jobs), { cookie: resumedAnalyst, body: proposal }), 200).job, done);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result, { ...read.result, owner: 'case-operator', revision: 2 });
  const events = await audit();
  assert.deepEqual(events.map(event => [event.action, event.account]), [
    ['operator.job.submitted', 'sample-intake'], ['operator.job.approved', 'sample-review'],
    ['rights.case.assign', 'sample-intake'], ['operator.job.succeeded', 'sample-intake'],
  ]);
  assert.equal(events[2].entityId, record.id);
  assert.equal((await getRights(resumed, resumedReviewer))[0].owner, 'case-operator');
  for (const response of [done, events]) {
    assert.doesNotMatch(JSON.stringify(response), /keyHash|idempotencyKey|Fictional rights intake/);
    assert.equal(JSON.stringify(response).includes(proposal.idempotencyKey), false);
  }

  const stale = status(await resumed.call(harbor(jobs), { cookie: resumedAnalyst, body: assign(record.id) }), 201).job;
  const staleAt = suffix => harbor(jobs + '/' + stale.id + suffix);
  status(await resumed.call(staleAt('/decision'), { cookie: resumedReviewer, body: decision }), 200);
  const fail = status(await resumed.call(staleAt('/run'), { cookie: resumedAnalyst, body: {} }), 200).job;
  assert.equal(fail.status, 'failed');
  assert.deepEqual(fail.failure, { code: 'STALE_REVISION' });
  assert.deepEqual(status(await resumed.call(staleAt('/run'), { cookie: resumedAnalyst, body: {} }), 200).job, fail);
  const staleAudit = status(await resumed.call(harbor(auditPath), { cookie: resumedReviewer }), 200).audit
    .filter(event => event.correlationId === stale.id);
  assert.deepEqual(staleAudit.slice(-2).map(event => event.action), ['rights.case.refused', 'operator.job.failed']);
  assert.equal((await getRights(resumed, resumedReviewer))[0].revision, 2);

  const rejected = status(await resumed.call(harbor(jobs), { cookie: resumedAnalyst, body: assign(record.id) }), 201).job;
  const rejectAt = suffix => harbor(jobs + '/' + rejected.id + suffix);
  const rejection = status(await resumed.call(rejectAt('/decision'), {
    cookie: resumedReviewer, body: { decision: 'reject' },
  }), 200).job;
  assert.equal(rejection.status, 'rejected');
  status(await resumed.call(rejectAt('/decision'), { cookie: resumedReviewer, body: decision }), 409, 'JOB_NOT_AWAITING_APPROVAL');
  status(await resumed.call(rejectAt('/run'), { cookie: resumedAnalyst, body: {} }), 409, 'JOB_NOT_RUNNABLE');
});
