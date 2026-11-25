'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { request } = require('node:http');
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
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited;
    if (access) await rm(dirname(access), { recursive: true, force: true });
  };
  t.after(() => stop());
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
  return { call, login, stop, url };
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

const auditPlans = '/api/audit-management';
const approve = { decision: 'approve' };

async function openAuditPlan(server, cookie, title) {
  const { controls } = status(await server.call(harbor('/api/risk-controls/controls'), {
    cookie, body: { title: 'Synthetic job control', intent: 'Fictional control objective', expectedRevision: 0 },
  }), 200);
  const { plans } = status(await server.call(harbor(auditPlans + '/plans'), {
    cookie, body: { title, objective: 'Fictional audit objective', scope: 'Fictional audit scope', controlIds: [controls[0].id] },
  }), 200);
  return plans[0];
}

async function finalizeAuditPlan(server, plan, analyst, reviewer) {
  const path = auditPlans + '/plans/' + plan.id + '/';
  let current = plan;
  async function change(action, cookie, fields = {}) {
    const result = status(await server.call(harbor(path + action), {
      cookie, body: { expectedRevision: current.revision, ...fields },
    }), 200);
    current = result.plans.find(row => row.id === plan.id);
  }
  if (current.status === 'planned') await change('begin', analyst);
  await change('assess', analyst, {
    controlId: plan.controls[0].id, evidenceReference: 'SYN-REHEARSAL-01', outcome: 'effective', observation: 'Fictional audit sample.',
  });
  await change('submit', analyst);
  await change('finalize', reviewer, { note: 'Reviewed only the fictional sample.' });
  return current;
}

test('audit jobs use pinned revisions, independent approval and the audit workflow transaction', async t => {
  const sqlite = await fixture(t);
  const first = await launch(t, sqlite);
  const peer = await launch(t, sqlite);
  const analyst = await first.login('sample-intake');
  const reviewer = await first.login('sample-review');
  const peerAnalyst = await peer.login('sample-intake');
  const orchard = await first.login('sample-orchard', 'orchard');
  const plan = await openAuditPlan(first, analyst, 'Synthetic audited plan');
  const submit = (action, args, idempotencyKey = randomUUID()) => ({ action, args, idempotencyKey });
  const planArgs = { planId: plan.id, expectedRevision: plan.revision };
  const proposal = submit('audit.plan.begin', planArgs);
  const readJob = submit('audit.plan.status', { planId: plan.id });

  status(await first.call(harbor(jobs), {
    cookie: analyst, body: submit('audit.plan.finalize', planArgs),
  }), 422, 'UNKNOWN_JOB_ACTION');
  status(await first.call(harbor(jobs), {
    cookie: analyst, body: submit('audit.plan.begin', { ...planArgs, note: 'extra text' }),
  }), 422, 'INVALID_JOB_INPUT');
  status(await first.call(harbor(jobs), { cookie: reviewer, body: proposal }), 403, 'ACCESS_DENIED');

  const pending = status(await first.call(harbor(jobs), { cookie: analyst, body: proposal }), 201).job;
  const urlFor = (jobId, command = '') => harbor(jobs + '/' + jobId + command);
  const run = (server, cookie, jobId) => server.call(urlFor(jobId, '/run'), { cookie, body: {} });
  const decide = (cookie, jobId, body = approve) => first.call(urlFor(jobId, '/decision'), { cookie, body });
  const planView = async () => status(await first.call(harbor(auditPlans), { cookie: reviewer }), 200).plans[0];
  const jobAudit = async jobId => status(await first.call(harbor(auditPath), { cookie: reviewer }), 200).audit
    .filter(event => event.correlationId === jobId);
  assert.equal(pending.status, 'awaiting-approval');
  status(await run(first, analyst, pending.id), 409, 'JOB_NOT_RUNNABLE');
  status(await decide(analyst, pending.id), 403, 'ACCESS_DENIED');
  status(await run(first, reviewer, pending.id), 404, 'JOB_NOT_FOUND');
  status(await first.call(jobs + '/' + pending.id + '?workspace=orchard', { cookie: orchard }), 404, 'JOB_NOT_FOUND');
  status(await first.call(harbor(jobs), {
    cookie: analyst, body: { ...readJob, idempotencyKey: proposal.idempotencyKey },
  }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal(status(await first.call(harbor(jobs), { cookie: reviewer }), 200).jobs[0].id, pending.id);

  const read = status(await first.call(harbor(jobs), { cookie: reviewer, body: readJob }), 201).job;
  status(await first.call(urlFor(read.id), { cookie: analyst }), 404, 'JOB_NOT_FOUND');
  const summary = status(await run(first, reviewer, read.id), 200).job;
  assert.deepEqual(summary.result, { planId: plan.id, status: 'planned', revision: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /Fictional audit|Synthetic audited plan|evidence|keyHash/);
  const foreign = status(await first.call(jobs + '?workspace=orchard', { cookie: orchard, body: readJob }), 201).job;
  const foreignRun = status(await first.call(jobs + '/' + foreign.id + '/run?workspace=orchard', {
    cookie: orchard, body: {},
  }), 200).job;
  assert.deepEqual(foreignRun.failure, { code: 'AUDIT_NOT_FOUND' });

  const approved = status(await decide(reviewer, pending.id), 200).job;
  assert.equal(approved.status, 'queued');
  assert.equal(approved.decision.by, 'sample-review');
  assert.deepEqual(await planView(), plan);
  const database = new DatabaseSync(sqlite);
  try {
    database.exec(`
      CREATE TRIGGER fail_audit_job_write BEFORE UPDATE ON snapshots
      WHEN NEW.scope = 'workspace:harbor' AND NEW.kind = 'workbench'
      BEGIN SELECT RAISE(ABORT, 'Synthetic audit job write failure'); END;
    `);
    status(await run(peer, peerAnalyst, pending.id), 500);
    assert.deepEqual(await planView(), plan);
    assert.deepEqual(status(await first.call(urlFor(pending.id), { cookie: analyst }), 200).job, approved);
    assert.deepEqual((await jobAudit(pending.id)).map(e => e.action), ['operator.job.submitted', 'operator.job.approved']);
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_audit_job_write');
    database.close();
  }

  const results = await Promise.all([run(first, analyst, pending.id), run(peer, peerAnalyst, pending.id)]);
  const done = status(results[0], 200).job;
  assert.deepEqual(status(results[1], 200).job, done);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result, { planId: plan.id, status: 'fieldwork', revision: 2 });
  const events = await jobAudit(done.id);
  assert.deepEqual(events.map(e => e.action), [
    'operator.job.submitted', 'operator.job.approved', 'audit-management.begin', 'operator.job.succeeded',
  ]);
  assert.equal(events[2].entityId, plan.id);
  assert.equal(events[2].account, 'sample-intake');
  assert.equal((await planView()).revision, 2);
  assert.deepEqual(status(await peer.call(harbor(jobs), {
    cookie: peerAnalyst, body: { ...proposal, args: { expectedRevision: 1, planId: plan.id } },
  }), 200).job, done);

  const stale = status(await first.call(harbor(jobs), {
    cookie: analyst, body: submit('audit.plan.begin', planArgs),
  }), 201).job;
  status(await decide(reviewer, stale.id), 200);
  assert.deepEqual(status(await run(first, analyst, stale.id), 200).job.failure, { code: 'STALE_REVISION' });
  assert.deepEqual((await jobAudit(stale.id)).slice(-2).map(e => e.action), [
    'audit-management.refused', 'operator.job.failed',
  ]);
  assert.equal((await planView()).revision, 2);

  const rejected = status(await first.call(harbor(jobs), {
    cookie: analyst, body: submit('audit.plan.begin', { ...planArgs, expectedRevision: 2 }),
  }), 201).job;
  assert.equal(status(await decide(reviewer, rejected.id, { decision: 'reject' }), 200).job.status, 'rejected');
  status(await run(first, analyst, rejected.id), 409, 'JOB_NOT_RUNNABLE');
});

test('browser operator jobs show and manage audit proposals with the correct roles', {
  skip: process.env.RUN_BROWSER_SMOKE !== '1' && 'Set RUN_BROWSER_SMOKE=1 with Playwright installed',
}, async t => {
  const server = await launch(t, await fixture(t));
  const jsonServer = await launch(t);
  const analystCookie = await server.login('sample-intake');
  const plan = await openAuditPlan(server, analystCookie, 'Synthetic browser audit plan');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const errors = [];
  async function pageFor(host, cookie) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.context().addCookies([{ name: 'trust_local_session', value: cookie.split('=')[1], url: host.url, httpOnly: true }]);
    await page.goto(host.url);
    await page.locator('#local-account').waitFor();
    return page;
  }
  const jobsButton = { name: 'Operator jobs', exact: true };
  const analyst = await pageFor(server, analystCookie);
  const reviewerCookie = await server.login('sample-review');
  const reviewer = await pageFor(server, reviewerCookie);
  const publisher = await pageFor(server, await server.login('sample-publisher'));
  const legacy = await pageFor(jsonServer, await jsonServer.login('sample-intake'));
  assert.equal(await publisher.getByRole('button', jobsButton).isVisible(), false);
  assert.equal(await legacy.getByRole('button', jobsButton).isVisible(), false);

  await analyst.getByRole('button', { name: 'Audit management', exact: true }).click();
  const auditCard = analyst.locator('#audit-management-view article').filter({ hasText: 'Synthetic browser audit plan' });
  await auditCard.getByRole('button', { name: 'Queue operator job' }).click();
  await analyst.getByRole('heading', { name: 'Queue operator job', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.equal(await analyst.getByLabel('Action', { exact: true }).inputValue(), 'audit.plan.begin');
  assert.equal(await analyst.getByLabel('Record ID (UUID)', { exact: true }).inputValue(), plan.id);
  assert.equal(await analyst.getByLabel('Expected revision', { exact: true }).inputValue(), '1');
  await analyst.getByRole('button', { name: 'Queue job', exact: true }).click();

  const card = page => page.locator('#operator-jobs-view article').filter({ hasText: plan.id });
  await card(analyst).getByText('Awaiting approval', { exact: true }).waitFor();
  assert.equal(await card(analyst).getByRole('button', { name: 'Approve job' }).count(), 0);
  assert.equal(await card(analyst).getByRole('button', { name: 'Run job' }).count(), 0);

  await reviewer.getByRole('button', jobsButton).click();
  await card(reviewer).getByRole('button', { name: 'Open audit plan' }).click();
  await reviewer.getByRole('heading', { name: 'Synthetic browser audit plan', exact: true }).waitFor();
  await reviewer.getByRole('button', jobsButton).click();
  await card(reviewer).getByRole('button', { name: 'Approve job' }).click();
  await card(reviewer).getByText('Queued', { exact: true }).waitFor();
  assert.equal(await card(reviewer).getByRole('button', { name: 'Run job' }).count(), 0);

  await analyst.getByRole('button', { name: 'Refresh jobs' }).click();
  await card(analyst).getByRole('button', { name: 'Run job' }).click();
  await card(analyst).getByText('Succeeded', { exact: true }).waitFor();
  await card(analyst).getByText('Record status fieldwork · Revision 2', { exact: true }).waitFor();
  await analyst.getByRole('button', { name: 'Audit management', exact: true }).click();
  await auditCard.getByText('fieldwork', { exact: true }).waitFor();

  const current = status(await server.call(harbor(auditPlans), { cookie: analystCookie }), 200).plans[0];
  const finalized = await finalizeAuditPlan(server, current, analystCookie, reviewerCookie);
  await analyst.reload();
  await analyst.getByRole('button', { name: 'Audit management', exact: true }).click();
  await auditCard.getByRole('button', { name: 'Queue operator job' }).click();
  assert.equal(await analyst.getByLabel('Action', { exact: true }).inputValue(), 'audit.plan.receipt-rehearsal');
  assert.equal(await analyst.getByLabel('Expected revision', { exact: true }).inputValue(), String(finalized.revision));
  await analyst.getByRole('button', { name: 'Queue job', exact: true }).click();
  const receiptCard = page => card(page).filter({ has: page.getByRole('heading', { name: 'Rehearse audit receipt' }) });
  await receiptCard(analyst).getByText('Awaiting approval', { exact: true }).waitFor();
  await reviewer.getByRole('button', { name: 'Refresh jobs' }).click();
  await receiptCard(reviewer).getByRole('button', { name: 'Approve job' }).click();
  await receiptCard(reviewer).getByText('Queued', { exact: true }).waitFor();
  await analyst.getByRole('button', { name: 'Refresh jobs' }).click();
  await receiptCard(analyst).getByRole('button', { name: 'Run job' }).click();
  await receiptCard(analyst).getByRole('button', { name: 'Retry job' }).click();
  await receiptCard(analyst).getByText('Needs reconciliation', { exact: true }).waitFor();
  assert.equal(await receiptCard(analyst).getByRole('button', { name: 'Reconcile receipt' }).count(), 0);
  await reviewer.getByRole('button', { name: 'Refresh jobs' }).click();
  await receiptCard(reviewer).getByRole('button', { name: 'Reconcile receipt' }).click();
  await receiptCard(reviewer).getByText(/^Synthetic receipt SYN-AUDIT-/).waitFor();
  await receiptCard(reviewer).getByText('Succeeded', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

function receipts(sqlite) {
  const db = new DatabaseSync(sqlite, { readOnly: true });
  try {
    const row = db.prepare("SELECT payload FROM snapshots WHERE scope = 'workspace:harbor' AND kind = 'workbench'").get();
    return JSON.parse(row.payload).operatorAuditReceipts ?? [];
  } finally {
    db.close();
  }
}

async function dropRetryBody(server, path, cookie) {
  await new Promise((resolve, reject) => {
    const req = request(server.url + path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' },
    }, reply => {
      if (reply.statusCode !== 200) {
        reply.resume();
        reject(new Error('Receipt retry returned HTTP ' + reply.statusCode));
        return;
      }
      // Headers are sent after the SQLite commit. Lose the result before reading the response body.
      reply.destroy();
      resolve();
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Receipt retry timed out.')));
    req.end('{}');
  });
}

test('one audit receipt survives a lost retry response and forced restart before reconciliation', async t => {
  const sqlite = await fixture(t);
  const first = await launch(t, sqlite);
  const analyst = await first.login('sample-intake');
  const reviewer = await first.login('sample-review');
  const draft = await openAuditPlan(first, analyst, 'Synthetic receipt rehearsal plan');
  const spec = {
    action: 'audit.plan.receipt-rehearsal',
    args: { planId: draft.id, expectedRevision: draft.revision }, idempotencyKey: randomUUID(),
  };
  const jobPath = (job, operation = '') => harbor(jobs + '/' + job.id + operation);
  const post = (server, cookie, path, body = {}) => server.call(path, { cookie, body });
  const submit = (server, cookie, body) => post(server, cookie, harbor(jobs), body);

  status(await submit(first, reviewer, spec), 403, 'ACCESS_DENIED');
  const premature = status(await submit(first, analyst, spec), 201).job;
  status(await post(first, reviewer, jobPath(premature, '/decision'), approve), 200);
  const failed = status(await post(first, analyst, jobPath(premature, '/run')), 200).job;
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, { code: 'AUDIT_NOT_FINAL' });
  assert.deepEqual(failed.attempts, []);

  const final = await finalizeAuditPlan(first, draft, analyst, reviewer);
  const proposal = { ...spec, args: { planId: final.id, expectedRevision: final.revision }, idempotencyKey: randomUUID() };
  const pending = status(await submit(first, analyst, proposal), 201).job;
  assert.equal(pending.status, 'awaiting-approval');
  assert.deepEqual(status(await submit(first, analyst, proposal), 200).job, pending);
  status(await submit(first, analyst, { ...proposal, idempotencyKey: randomUUID() }), 409, 'RECEIPT_JOB_EXISTS');
  status(await post(first, analyst, jobPath(pending, '/run')), 409, 'JOB_NOT_RUNNABLE');
  status(await post(first, analyst, jobPath(pending, '/retry')), 409, 'JOB_NOT_RETRYABLE');
  status(await post(first, analyst, jobPath(pending, '/decision'), approve), 403, 'ACCESS_DENIED');
  status(await post(first, reviewer, jobPath(pending, '/decision'), approve), 200);
  status(await post(first, reviewer, jobPath(pending, '/reconcile')), 409, 'JOB_NOT_RECONCILABLE');

  const retryable = status(await post(first, analyst, jobPath(pending, '/run')), 200).job;
  assert.equal(retryable.status, 'retryable');
  assert.deepEqual(retryable.attempts.map(({ number, outcome }) => [number, outcome]), [[1, 'retryable-before-effect']]);
  assert.deepEqual(receipts(sqlite), []);
  assert.deepEqual(status(await post(first, analyst, jobPath(pending, '/run')), 200).job, retryable);
  status(await post(first, reviewer, jobPath(pending, '/retry')), 403, 'ACCESS_DENIED');

  await dropRetryBody(first, jobPath(pending, '/retry'), analyst);
  await first.stop('SIGKILL');

  const restarted = await launch(t, sqlite);
  const freshAnalyst = await restarted.login('sample-intake');
  const freshReviewer = await restarted.login('sample-review');
  const orchardReviewer = await restarted.login('sample-intake', 'orchard');
  const ambiguous = status(await restarted.call(jobPath(pending), { cookie: freshAnalyst }), 200).job;
  assert.equal(ambiguous.status, 'needs-reconciliation');
  assert.equal(ambiguous.result, undefined);
  assert.deepEqual(ambiguous.attempts.map(({ number, outcome }) => [number, outcome]), [
    [1, 'retryable-before-effect'], [2, 'acknowledgment-unknown'],
  ]);
  const ledger = receipts(sqlite);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0], {
    id: 'SYN-AUDIT-' + pending.id, jobId: pending.id, planId: final.id,
    revision: final.revision, recordedAt: ambiguous.attempts[1].at,
  });
  assert.deepEqual(status(await submit(restarted, freshAnalyst, proposal), 200).job, ambiguous);
  const replays = await Promise.all([
    post(restarted, freshAnalyst, jobPath(pending, '/run')),
    post(restarted, freshAnalyst, jobPath(pending, '/retry')),
    post(restarted, freshAnalyst, jobPath(pending, '/retry')),
  ]);
  for (const replay of replays) assert.deepEqual(status(replay, 200).job, ambiguous);
  status(await post(restarted, freshAnalyst, jobPath(pending, '/reconcile')), 403, 'ACCESS_DENIED');
  status(await post(restarted, orchardReviewer, jobs + '/' + pending.id + '/reconcile?workspace=orchard'), 404, 'JOB_NOT_FOUND');

  const done = status(await post(restarted, freshReviewer, jobPath(pending, '/reconcile')), 200).job;
  assert.equal(done.status, 'succeeded');
  assert.equal(done.reconciliation.by, 'sample-review');
  assert.deepEqual(done.result, { planId: final.id, status: 'finalized', revision: final.revision, receiptId: ledger[0].id });
  assert.deepEqual(status(await post(restarted, freshReviewer, jobPath(pending, '/reconcile')), 200).job, done);
  assert.deepEqual(status(await post(restarted, freshAnalyst, jobPath(pending, '/retry')), 200).job, done);
  status(await submit(restarted, freshAnalyst, { ...proposal, idempotencyKey: randomUUID() }), 409, 'RECEIPT_JOB_EXISTS');
  assert.deepEqual(receipts(sqlite), ledger);
  const { plans } = status(await restarted.call(harbor(auditPlans), { cookie: freshReviewer }), 200);
  assert.deepEqual(plans[0], final);
  const { audit } = status(await restarted.call(harbor(auditPath), { cookie: freshReviewer }), 200);
  const events = audit.filter(event => event.correlationId === pending.id);
  assert.deepEqual(events.map(e => [e.action, e.account, e.details.attempt]), [
    ['operator.job.submitted', 'sample-intake', undefined],
    ['operator.job.approved', 'sample-review', undefined],
    ['operator.job.retryable', 'sample-intake', 1],
    ['operator.job.needs-reconciliation', 'sample-intake', 2],
    ['operator.job.reconciled', 'sample-review', undefined],
  ]);
  assert.equal(events.at(-1).details.receiptId, ledger[0].id);
});
