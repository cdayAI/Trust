'use strict';

const operatorJobsPane = $('#operator-jobs-view');
const operatorJobsPath = '/api/operator/v1/jobs';
const operatorJobActions = {
  'rights.case.status': { label: 'Read rights case status', idField: 'caseId' },
  'rights.case.assign': { label: 'Reassign rights case to case operator', idField: 'caseId', approval: true },
  'audit.plan.status': { label: 'Read audit plan status', idField: 'planId' },
  'audit.plan.begin': { label: 'Begin audit fieldwork', idField: 'planId', approval: true },
};
const operatorJobStatuses = {
  'awaiting-approval': 'Awaiting approval', queued: 'Queued', succeeded: 'Succeeded', failed: 'Failed', rejected: 'Rejected',
};
let operatorJobPrefill;

function openAuditPlanJobs(plan) {
  operatorJobPrefill = {
    action: localSession.actor === 'analyst' && plan.status === 'planned' ? 'audit.plan.begin' : 'audit.plan.status',
    recordId: plan.id,
    revision: plan.revision,
  };
  switchView('operator-jobs');
}

function mountOperatorJobs() {
  const session = localSession;
  const seed = operatorJobPrefill;
  operatorJobPrefill = undefined;
  const fields = el('select');
  fields.setAttribute('aria-labelledby', 'operator-job-action-label');
  const actionText = el('span', 'Action');
  actionText.id = 'operator-job-action-label';
  for (const [action, spec] of Object.entries(operatorJobActions)) {
    if (spec.approval && session.actor !== 'analyst') continue;
    const option = el('option', spec.label);
    option.value = action;
    fields.append(option);
  }
  if (seed) fields.value = seed.action;
  const recordId = el('input');
  recordId.required = true;
  recordId.spellcheck = false;
  recordId.pattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  recordId.value = seed?.recordId ?? '';
  const revision = el('input');
  revision.type = 'number';
  revision.min = '1';
  revision.step = '1';
  revision.required = true;
  revision.value = seed?.revision ?? '';
  const revisionLabel = add(el('label', 'Expected revision'), revision);
  function syncRevision() {
    revision.disabled = revisionLabel.hidden = !operatorJobActions[fields.value].approval;
  }
  fields.onchange = syncRevision;
  syncRevision();

  const form = add(el('form'), add(el('label'), actionText, fields), add(el('label', 'Record ID (UUID)'), recordId),
    revisionLabel, button('Queue job', 'submit'));
  const refresh = button('Refresh jobs', 'button', 'secondary');
  const list = add(el('div'), el('p', 'Loading operator jobs…'));
  const status = el('p');
  status.setAttribute('role', 'status');
  const intro = add(el('section'), heading('Queue operator job'), form, status);
  const panel = add(el('section'), heading('Jobs'), refresh, list);
  operatorJobsPane.replaceChildren(intro, panel);

  let rows = [], pending = false, draft;
  const current = () => localSession === session && !operatorJobsPane.hidden && operatorJobsPane.contains(list);
  const post = (suffix, body) => read(operatorJobsPath + suffix, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  function updateJob({ job }) {
    const index = rows.findIndex(row => row.id === job.id);
    if (index === -1) rows.push(job);
    else rows[index] = job;
    return job;
  }
  function changeJob(job, command, body) {
    return async () => updateJob(await post('/' + job.id + '/' + command, body));
  }
  function renderJobs(focusId) {
    list.replaceChildren();
    if (!rows.length) list.append(el('p', 'No operator jobs yet.'));
    for (const job of rows.slice().reverse()) {
      const spec = operatorJobActions[job.action];
      const card = add(el('article', undefined, 'module-record'), el('h3', spec?.label ?? job.action),
        badge(operatorJobStatuses[job.status] ?? job.status),
        el('p', 'Job ID ' + job.id, 'hint'), el('p', 'Requested by ' + job.requestedBy, 'hint'));
      if (spec) {
        const id = job.args[spec.idField];
        const audit = spec.idField === 'planId';
        const open = button(audit ? 'Open audit plan' : 'Open rights case', 'button', 'secondary');
        open.onclick = () => openWorkTask({ view: audit ? 'audit-management' : 'rights', recordId: id });
        card.append(el('p', 'Record ID ' + id, 'hint'), open);
      }
      if (job.args.expectedRevision !== undefined) card.append(el('p', 'Expected revision ' + job.args.expectedRevision));
      if (job.decision) card.append(el('p', (job.decision.value === 'approve' ? 'Approved' : 'Rejected') + ' by ' + job.decision.by));
      if (job.result) card.append(el('p', 'Record status ' + job.result.status + ' · Revision ' + job.result.revision));
      if (job.failure) card.append(el('p', 'Failure ' + job.failure.code));
      if (job.status === 'awaiting-approval' && session.actor === 'reviewer' && job.requestedBy !== session.account) {
        const approve = button('Approve job'), reject = button('Reject job', 'button', 'secondary');
        approve.onclick = () => perform(changeJob(job, 'decision', { decision: 'approve' }));
        reject.onclick = () => perform(changeJob(job, 'decision', { decision: 'reject' }));
        card.append(add(el('div', undefined, 'actions'), approve, reject));
      }
      if (job.status === 'queued' && job.requestedBy === session.account) {
        const run = button('Run job');
        run.onclick = () => perform(changeJob(job, 'run', {}));
        card.append(run);
      }
      list.append(card);
      if (job.id === focusId) {
        card.tabIndex = -1;
        card.focus();
      }
    }
  }

  async function perform(task) {
    if (pending) return;
    pending = true;
    for (const control of operatorJobsPane.querySelectorAll('button')) control.disabled = true;
    status.textContent = '';
    try {
      const job = await task();
      if (current()) {
        renderJobs(job?.id);
        if (job) status.textContent = 'Job ' + operatorJobStatuses[job.status].toLowerCase() + '.';
      }
    } catch (error) {
      if (current()) {
        status.textContent = error.message;
        if (!list.querySelector('article')) list.replaceChildren(el('p', 'Use Refresh jobs to retry.'));
      }
    } finally {
      pending = false;
      if (current()) for (const control of operatorJobsPane.querySelectorAll('button')) control.disabled = false;
    }
  }

  form.onsubmit = event => {
    event.preventDefault();
    if (pending) return;
    const action = fields.value;
    const spec = operatorJobActions[action];
    const args = { [spec.idField]: recordId.value, ...(spec.approval ? { expectedRevision: revision.valueAsNumber } : {}) };
    const request = { action, args };
    const signature = JSON.stringify(request);
    if (draft?.signature !== signature) draft = { signature, key: crypto.randomUUID() };
    perform(async () => {
      const reply = await post('', { ...request, idempotencyKey: draft.key });
      draft = undefined;
      return updateJob(reply);
    });
  };
  function refreshJobs() {
    return perform(async () => { ({ jobs: rows } = await read(operatorJobsPath)); });
  }
  refresh.onclick = refreshJobs;
  refreshJobs();
}
$('#show-operator-jobs').onclick = () => switchView('operator-jobs');
