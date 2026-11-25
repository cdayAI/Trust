'use strict';

const { createHash, randomUUID } = require('node:crypto');
const rightsCase = {
  idField: 'caseId',
  get: (state, id) => state.rightsCases?.find(row => row.id === id),
  missing: 'CASE_NOT_FOUND',
  summarize: ({ id: caseId, kind, owner, status, revision }) => ({ caseId, kind, owner, status, revision }),
};
const auditPlan = {
  idField: 'planId',
  get: (state, id) => state.auditManagement?.plans.find(row => row.id === id),
  missing: 'AUDIT_NOT_FOUND',
  summarize: ({ id: planId, status, revision }) => ({ planId, status, revision }),
};
const actions = new Map([
  ['rights.case.status', rightsCase],
  ['rights.case.assign', {
    ...rightsCase,
    command: (id, expectedRevision) => [
      ['rights', 'cases', id, 'assign'],
      { expectedRevision, owner: 'case-operator', note: 'Synthetic operator job reassignment.' },
    ],
  }],
  ['audit.plan.status', auditPlan],
  ['audit.plan.begin', {
    ...auditPlan,
    command: (id, expectedRevision) => [['audit-management', 'plans', id, 'begin'], { expectedRevision }],
  }],
]);
const needsApproval = action => Boolean(actions.get(action)?.command);
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
  const definition = actions.get(action);
  if (!definition) fail(422, 'UNKNOWN_JOB_ACTION', 'Select an allowlisted operator action.');
  const { idField, command } = definition;
  if (command && role !== 'analyst') {
    fail(403, 'ACCESS_DENIED', 'Only the analyst can request this operator change.');
  }
  exact(args, command ? [idField, 'expectedRevision'] : [idField]);
  if (typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey) ||
      typeof args[idField] !== 'string' || !uuid.test(args[idField]) ||
      (command && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1))) {
    fail(422, 'INVALID_JOB_INPUT', 'Use lowercase random UUIDs and a positive revision for changes.');
  }
  return {
    action,
    args: { [idField]: args[idField], ...(command ? { expectedRevision: args.expectedRevision } : {}) },
    keyHash: createHash('sha256').update(idempotencyKey).digest('hex'),
  };
}

function owns(job, caller) {
  return job.requestedBy === caller.account && job.requestedRole === caller.actor;
}

function canSee(job, caller) {
  return owns(job, caller) || (caller.actor === 'reviewer' && needsApproval(job.action));
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

function execute(state, job, caller, audit, applyProgram) {
  const definition = actions.get(job.action);
  if (!definition) throw new Error('Invalid stored operator action.');
  const { idField, get, missing, summarize, command } = definition;
  const id = job.args[idField];
  const record = get(state, id);
  if (!record) return { failure: { code: missing } };

  if (command) {
    const [parts, body] = command(id, job.args.expectedRevision);
    try {
      applyProgram(state, parts, caller.actor, body, audit, caller.account);
    } catch (error) {
      // Validated domain refusals deliberately append an audit event.
      if (!error.persistRefusal) throw error;
      return { failure: { code: error.code } };
    }
  }
  return { result: summarize(command ? get(state, id) : record) };
}

function change(state, caller, operation, id, body, event, applyProgram) {
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
      createdAt: now, status: needsApproval(input.action) ? 'awaiting-approval' : 'queued',
    };
    jobs.push(job);
    return record(job, 'submitted');
  }

  if (operation === 'decision') {
    exact(body, ['decision']);
    if (!['approve', 'reject'].includes(body.decision)) {
      fail(422, 'INVALID_JOB_INPUT', 'Select approve or reject.');
    }
    const job = find(jobs, id, row => needsApproval(row.action));
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
  if (job.status !== 'queued' || (needsApproval(job.action) && job.decision?.value !== 'approve')) {
    fail(409, 'JOB_NOT_RUNNABLE', 'Only queued jobs with any required approval can run.');
  }
  const outcome = execute(state, job, caller, auditFor(job), applyProgram);
  Object.assign(job, outcome, { status: outcome.failure ? 'failed' : 'succeeded' });
  return record(job, job.status);
}

module.exports = { read, change };
