'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../server');

const workflow = {
  id: 'synthetic-proof',
  initial: 'draft',
  states: [
    { id: 'draft', label: 'Draft' },
    { id: 'review', label: 'Awaiting review' },
    { id: 'approved', label: 'Approved by review' },
  ],
  transitions: [
    { id: 'submit', from: 'draft', to: 'review', roles: ['initiator'], requiredFields: ['summary'] },
    { id: 'approve', from: 'review', to: 'approved', roles: ['initiator', 'reviewer'], independent: true, requiredFields: ['reason'] },
  ],
};

test('workflow HTTP: published version pinning, independent review, stale race and durable audit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-workflow-http-'));
  const dataFile = join(dir, 'state.json');
  let server;
  let url;
  const stop = async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  const start = async () => {
    server = createServer({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port + '/api/workflows/';
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  await start();

  const call = async (path, actor, payload) => {
    const response = await fetch(url + path, actor ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor },
      body: JSON.stringify(payload),
    } : undefined);
    return { status: response.status, body: await response.json() };
  };
  const expect = async (status, path, actor, payload) => {
    const result = await call(path, actor, payload);
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  };

  const deniedPublisher = await expect(403, 'definitions', 'analyst', { definition: workflow, expectedVersion: 0 });
  assert.equal(deniedPublisher.code, 'ROLE_REQUIRED');
  const ownV1 = (await expect(200, 'definitions', 'publisher', { definition: workflow, expectedVersion: 0 })).definition;
  const oldCase = (await expect(200, 'instances', 'analyst', { definitionId: workflow.id, title: 'Synthetic case in v1' })).instance;
  assert.equal(oldCase.definitionVersion, 1);
  assert.equal(oldCase.revision, 1);
  const version2 = structuredClone(workflow);
  version2.states[1].label = 'Peer review in v2';
  version2.transitions[0].requiredFields.push('retentionNote');
  const ownV2 = (await expect(200, 'definitions', 'publisher', { definition: version2, expectedVersion: 1 })).definition;
  const stalePublish = await expect(409, 'definitions', 'publisher', { definition: version2, expectedVersion: 1 });
  assert.equal(stalePublish.code, 'STALE_DEFINITION');
  assert.deepEqual(await expect(200, 'definitions/' + workflow.id + '/1'), ownV1);
  assert.deepEqual(await expect(200, 'definitions/' + workflow.id + '/2'), ownV2);

  const newCase = (await expect(200, 'instances', 'analyst', { definitionId: workflow.id, title: 'Synthetic case in v2' })).instance;
  assert.equal(newCase.definitionVersion, 2);
  const advance = c => 'instances/' + c.id + '/transitions';
  const submit = { transitionId: 'submit', expectedRevision: 1, fields: { summary: 'Synthetic fixture only.' } };
  const approve = { transitionId: 'approve', expectedRevision: 2, fields: { reason: 'Verified synthetic safeguards.' } };
  const skip = await expect(409, advance(oldCase), 'reviewer', { ...approve, expectedRevision: 1 });
  assert.equal(skip.code, 'TRANSITION_NOT_AVAILABLE');
  const missing = await expect(422, advance(newCase), 'analyst', submit);
  assert.equal(missing.code, 'MISSING_FIELDS');
  assert.deepEqual(missing.event.missing, ['retentionNote']);
  assert.deepEqual(await expect(200, 'instances/' + newCase.id), newCase);
  assert.equal((await expect(200, advance(oldCase), 'analyst', submit)).instance.state, 'review');
  const denied = await expect(403, advance(oldCase), 'analyst', approve);
  assert.equal(denied.code, 'INDEPENDENCE_REQUIRED');

  const results = await Promise.all([call(advance(oldCase), 'reviewer', approve), call(advance(oldCase), 'reviewer', approve)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const approved = results.find(r => r.status === 200).body.instance;
  assert.equal(results.find(r => r.status === 409).body.code, 'STALE_REVISION');
  assert.equal(approved.definitionVersion, 1);
  assert.equal(approved.revision, 3);
  assert.equal(approved.state, 'approved');
  assert.deepEqual(approved.steps.map(x => [x.transitionId, x.actorId]), [['submit', 'analyst'], ['approve', 'reviewer']]);

  const audit = (await expect(200, 'audit')).audit;
  const events = audit.filter(e => e.instanceId === oldCase.id);
  assert.deepEqual(events.map(e => [e.outcome, e.code]), [
    ['accepted', null], ['refused', 'TRANSITION_NOT_AVAILABLE'], ['accepted', null],
    ['refused', 'INDEPENDENCE_REQUIRED'], ['accepted', null], ['refused', 'STALE_REVISION'],
  ]);
  assert.deepEqual(audit.map(e => e.sequence), audit.map((_, i) => i + 1));
  await stop();
  await start();
  assert.deepEqual(await expect(200, 'instances/' + oldCase.id), approved);
  assert.deepEqual(await expect(200, 'instances/' + newCase.id), newCase);
  assert.deepEqual(await expect(200, 'definitions/' + workflow.id + '/1'), ownV1);
  assert.deepEqual((await expect(200, 'audit')).audit, audit);
});
