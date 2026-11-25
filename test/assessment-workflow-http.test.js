'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../server');

test('assessment actions use a pinned workflow with independent review and revision checks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-assessment-workflow-'));
  const dataFile = join(dir, 'workspace.json');
  let server;
  let url;
  const stop = async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  const start = async () => {
    server = createServer({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port + '/api/';
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  await start();
  async function request(path, actor, payload) {
    const r = await fetch(url + path, actor ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor }, body: JSON.stringify(payload),
    } : undefined);
    return { status: r.status, body: await r.json() };
  }
  async function expect(code, path, actor, payload) {
    const r = await request(path, actor, payload);
    assert.equal(r.status, code, JSON.stringify(r.body));
    return r.body;
  }
  const seed = await expect(200, 'state');
  const ai = seed.assessments.find(a => a.type === 'ai');
  assert.ok(ai.workflowInstanceId);
  assert.equal(ai.workflowDefinitionVersion, 1);
  assert.ok(Number.isInteger(ai.workflowRevision));
  assert.equal(ai.status, 'draft');
  // Standalone publishers must not change the application-owned assessment lifecycle,
  // even when they deliberately choose the same definition ID in their own store.
  const independentDefinition = {
    id: 'assessment-review', initial: 'unrelated',
    states: [{ id: 'unrelated', label: 'Unrelated' }, { id: 'done', label: 'Done' }],
    transitions: [{ id: 'complete', from: 'unrelated', to: 'done', roles: ['initiator'] }],
  };
  await expect(200, 'workflows/definitions', 'publisher', { definition: independentDefinition, expectedVersion: 0 });
  await expect(200, 'workflows/definitions', 'publisher', { definition: independentDefinition, expectedVersion: 1 });
  assert.equal((await expect(200, 'workflows/definitions/assessment-review')).version, 2);

  const route = action => 'assessments/' + ai.id + '/' + action;
  const row = state => state.assessments.find(a => a.id === ai.id);
  const answers = { automatedAction:'No', summary: 'Synthetic ticket content only.', safeguards: 'Synthetic human review and no external transfer.' };
  await expect(422, route('submit'), 'analyst', {answers});
  const submitted = row(await expect(200, route('submit'), 'analyst', { answers, expectedRevision: ai.revision }));
  assert.equal(submitted.status, 'in_review');
  assert.equal(submitted.submittedBy, 'analyst');
  assert.equal(submitted.workflowInstanceId, ai.workflowInstanceId);
  assert.equal(submitted.workflowDefinitionVersion, ai.workflowDefinitionVersion);
  assert.ok(submitted.workflowRevision > ai.workflowRevision);
  await expect(403, route('approve'), 'analyst', { reason: 'Self approval not permitted', expectedRevision: submitted.revision });
  const incompleteReturn = await expect(422, route('reject'), 'reviewer', { expectedRevision: submitted.revision });
  assert.equal(incompleteReturn.code, 'MISSING_FIELDS');
  assert.deepEqual(row(await expect(200, 'state')), submitted);
  const rejected = row(await expect(200, route('reject'), 'reviewer', { reason: 'Specify synthetic deletion timing.', expectedRevision: submitted.revision }));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decisionBy, 'reviewer');
  assert.ok(rejected.workflowRevision > submitted.workflowRevision);
  const resubmitted = row(await expect(200, route('submit'), 'analyst', {
    answers:{...answers, safeguards: 'Synthetic human review; delete fixture after 7 days.'}, expectedRevision: rejected.revision,
  }));
  assert.equal(resubmitted.status, 'in_review');
  const outcome = await Promise.all([1, 2].map(() => request(route('approve'), 'reviewer', {
    reason: 'Synthetic safeguard reviewed.', expectedRevision: resubmitted.revision,
  })));
  assert.deepEqual(outcome.map(x => x.status).sort(), [200, 409]);
  const approved = row(outcome.find(x => x.status === 200).body);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decisionBy, 'reviewer');
  assert.equal(approved.workflowInstanceId, ai.workflowInstanceId);
  assert.equal(approved.workflowDefinitionVersion, ai.workflowDefinitionVersion);
  const audit = (await expect(200, 'audit/export')).audit;
  const events = audit.filter(e => e.entityId === ai.id);
  assert.deepEqual(events.map(e => e.action), [
    'assessment.created', 'assessment.refused', 'assessment.submitted', 'assessment.refused',
    'assessment.refused', 'assessment.rejected', 'assessment.submitted', 'assessment.approved', 'assessment.refused',
  ]);
  assert.deepEqual(events.filter(e => e.action === 'assessment.refused').map(e => e.details.code), [
    'INVALID_EXPECTED_REVISION', 'ROLE_REQUIRED', 'MISSING_FIELDS', 'STALE_REVISION',
  ]);
  assert.ok(events.find(e => e.details.code === 'MISSING_FIELDS').details.workflowEventId);
  assert.ok(events.every(e => e.details.workflowInstanceId === ai.workflowInstanceId));
  const workflowEvents = events.filter(e => e.action !== 'assessment.refused').map(e => e.details.workflowEventId);
  assert.ok(workflowEvents.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(workflowEvents).size, workflowEvents.length);
  await stop();
  await start();
  assert.deepEqual(row(await expect(200, 'state')), approved);
  assert.deepEqual((await expect(200, 'audit/export')).audit, audit);
});

test('legacy assessments keep their decisions and audit without manufactured workflow history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-assessment-legacy-'));
  const dataFile = join(dir, 'legacy.json');
  const project = { id: 'legacy-project', name: 'Synthetic legacy project', description: '' };
  const vendor = { id: 'legacy-vendor', name: 'Synthetic legacy vendor', projectId: project.id, description: '', usesAI: true };
  const actors = [{ id: 'analyst', role: 'analyst' }, { id: 'reviewer', role: 'reviewer' }];
  const assessments = ['approved', 'in_review', 'rejected'].map((status, i) => ({
    id: 'legacy-' + i, projectId: project.id, vendorId: vendor.id,
    type: i === 1 ? 'ai' : 'privacy', status, revision: i + 5,
    answers: { summary: 'Synthetic legacy scope', safeguards: 'Synthetic legacy safeguards' },
    submittedBy: 'analyst', decisionBy: status === 'in_review' ? null : 'reviewer',
    decisionReason: status === 'in_review' ? null : 'Historical synthetic reviewer note',
  }));
  const audit = [];
  for (const a of assessments) {
    for (const action of ['submitted', ...(a.status === 'in_review' ? [] : [a.status])]) {
      const sequence = audit.length + 1;
      audit.push({
        id: 'legacy-event-' + sequence, sequence, at: '2026-01-01T01:00:00.000Z',
        projectId: project.id, entityId: a.id, action: 'assessment.' + action,
        actor: action === 'submitted' ? 'analyst' : 'reviewer', details: { revision: a.revision },
      });
    }
  }
  await writeFile(dataFile, JSON.stringify({
    version: 1, actors, projects: [project], vendors: [vendor], assessments, handoff: [], audit,
  }));
  let server;
  const stop = async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  async function reopen() {
    await stop();
    server = createServer({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/state');
    assert.equal(r.status, 200);
    return r.json();
  }

  const migrated = await reopen();
  assert.deepEqual(migrated.audit.slice(0, audit.length), audit);
  const baselines = migrated.audit.slice(audit.length);
  assert.equal(baselines.length, assessments.length);
  assert.ok(baselines.every(e => e.action === 'assessment.workflow-baseline' && e.actor === 'system'));
  assert.equal(migrated.assessmentWorkflow.definitions.length, 1);
  assert.equal(migrated.assessmentWorkflow.instances.length, assessments.length);
  assert.equal(migrated.assessmentWorkflow.events.filter(e => e.kind === 'instance.advance').length, 0);
  for (const old of assessments) {
    const current = migrated.assessments.find(a => a.id === old.id);
    assert.deepEqual(Object.fromEntries(Object.keys(old).map(k => [k, current[k]])), old);
    assert.equal(current.workflowDefinitionVersion, 1);
    const instance = migrated.assessmentWorkflow.instances.find(i => i.id === current.workflowInstanceId);
    assert.equal(instance.state, { approved: 'approved', in_review: 'in-review', rejected: 'returned' }[old.status]);
    assert.deepEqual(instance.steps, []);
    assert.deepEqual(instance.legacyBaseline, {
      status: old.status, assessmentRevision: old.revision, submittedBy: old.submittedBy, decisionBy: old.decisionBy,
    });
    const baseline = baselines.find(e => e.entityId === old.id);
    assert.equal(baseline.details.workflowInstanceId, instance.id);
    assert.equal(baseline.details.status, old.status);
  }
  assert.deepEqual(await reopen(), migrated);
});
