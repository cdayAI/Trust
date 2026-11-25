'use strict';

const { createHash, randomUUID } = require('node:crypto');
const rights = require('./rights-workflow');

const lookup = 'rights.case.status';
const assign = 'rights.case.assign';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function exact(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== fields.length || !fields.every(field => Object.hasOwn(body, field))) {
    fail(422, 'INVALID_JOB_INPUT', 'Use the documented operator job fields.');
  }
}

function submission(body, role) {
  exact(body, ['action', 'args', 'idempotencyKey']);
  const { action, args, idempotencyKey } = body;
  if (![lookup, assign].includes(action)) {
    fail(422, 'UNKNOWN_JOB_ACTION', 'Select an allowlisted operator action.');
  }
  if (action === assign && role !== 'analyst') {
    fail(403, 'ACCESS_DENIED', 'Only the intake analyst can request this reassignment.');
  }
  exact(args, action === assign ? ['caseId', 'expectedRevision'] : ['caseId']);
  if (typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey) ||
      typeof args.caseId !== 'string' || !uuid.test(args.caseId) ||
      (action === assign && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1))) {
    fail(422, 'INVALID_JOB_INPUT', 'Use lowercase random UUIDs and a positive case revision for reassignment.');
  }
  return {
    action,
    args: action === assign ? { caseId: args.caseId, expectedRevision: args.expectedRevision } : { caseId: args.caseId },
    keyHash: createHash('sha256').update(idempotencyKey).digest('hex'),
  };
}

function owns(job, caller) {
  return job.requestedBy === caller.account && job.requestedRole === caller.actor;
}

function canSee(job, caller) {
  return owns(job, caller) || (caller.actor === 'reviewer' && job.action === assign);
}

function view(job) {
  const { keyHash, requestedRole, ...visible } = job;
  return visible;
}

function find(jobs, id, allowed) {
  const job = jobs.find(row => row.id === id && allowed(row));
  if (!job) fail(404, 'JOB_NOT_FOUND', 'Operator job not found.');
  return job;
}

function read(state, caller, id) {
  const jobs = state.operatorJobs ?? [];
  const visible = job => canSee(job, caller);
  if (id) return { job: view(find(jobs, id, visible)) };
  return { jobs: jobs.filter(visible).map(view) };
}

function execute(state, job, caller, audit) {
  const current = () => state.rightsCases?.find(row => row.id === job.args.caseId);
  if (!current()) return { failure: { code: 'CASE_NOT_FOUND' } };

  if (job.action === assign) {
    try {
      rights.change(state, ['rights', 'cases', job.args.caseId, 'assign'], caller.actor, {
        expectedRevision: job.args.expectedRevision,
        owner: 'case-operator',
        note: 'Synthetic operator job reassignment.',
      }, audit);
    } catch (error) {
      // The rights workflow explicitly saves the refusal audit for these errors.
      if (!error.persistRefusal) throw error;
      return { failure: { code: error.code } };
    }
  }
  const { id: caseId, kind, owner, status, revision } = current();
  return { result: { caseId, kind, owner, status, revision } };
}

function change(state, caller, operation, id, body, event) {
  const jobs = state.operatorJobs ??= [];
  const now = new Date().toISOString();

  function auditFor(job) {
    return (snapshot, actor, action, projectId, entityId, details) => {
      event(snapshot, actor, action, projectId, entityId, details);
      Object.assign(snapshot.audit.at(-1), { account: caller.account, correlationId: job.id });
    };
  }
  function record(job, action) {
    job.updatedAt = now;
    auditFor(job)(state, caller.actor, 'operator.job.' + action, null, job.id, {
      action: job.action, status: job.status, ...(job.failure ? { code: job.failure.code } : {}),
    });
    return { changed: true, job: view(job) };
  }

  if (operation === 'submit') {
    const input = submission(body, caller.actor);
    const previous = jobs.find(row => row.requestedBy === caller.account && row.keyHash === input.keyHash);
    if (previous) {
      if (previous.action !== input.action || JSON.stringify(previous.args) !== JSON.stringify(input.args)) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'This key already belongs to a different operator request.');
      }
      // The original submitting role is required even if account grants are later reconfigured.
      if (!owns(previous, caller)) fail(403, 'ACCESS_DENIED', 'The submitting role has changed.');
      return { job: view(previous) };
    }
    const job = {
      ...input, id: randomUUID(), requestedBy: caller.account, requestedRole: caller.actor,
      createdAt: now, status: input.action === assign ? 'awaiting-approval' : 'queued',
    };
    jobs.push(job);
    return record(job, 'submitted');
  }

  if (operation === 'decision') {
    exact(body, ['decision']);
    if (!['approve', 'reject'].includes(body.decision)) {
      fail(422, 'INVALID_JOB_INPUT', 'Select approve or reject.');
    }
    const job = find(jobs, id, row => row.action === assign);
    if (caller.actor !== 'reviewer' || caller.account === job.requestedBy) {
      fail(403, 'INDEPENDENT_REVIEW_REQUIRED', 'An independent reviewer must decide this request.');
    }
    if (job.decision?.value === body.decision && job.decision.by === caller.account) return { job: view(job) };
    if (job.status !== 'awaiting-approval') {
      fail(409, 'JOB_NOT_AWAITING_APPROVAL', 'This job has already been decided.');
    }
    job.decision = { value: body.decision, by: caller.account, at: now };
    job.status = body.decision === 'approve' ? 'queued' : 'rejected';
    return record(job, body.decision === 'approve' ? 'approved' : 'rejected');
  }

  if (operation !== 'run') fail(404, 'NOT_FOUND', 'Operator route not found.');
  exact(body, []);
  const job = find(jobs, id, row => owns(row, caller));
  if (['succeeded', 'failed'].includes(job.status)) return { job: view(job) };
  if (job.status !== 'queued' || (job.action === assign && job.decision?.value !== 'approve')) {
    fail(409, 'JOB_NOT_RUNNABLE', 'Only queued jobs with any required approval can run.');
  }
  const outcome = execute(state, job, caller, auditFor(job));
  Object.assign(job, outcome, { status: outcome.failure ? 'failed' : 'succeeded' });
  return record(job, job.status);
}

module.exports = { read, change };
