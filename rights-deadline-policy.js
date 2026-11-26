'use strict';
const node_crypto_1 = require("node:crypto");
const rust = require('./rust-core');
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const int = (value, min, max) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const kinds = Object.freeze(['access', 'deletion', 'correction', 'portability', 'opt-out']);
const bases = Object.freeze(['calendar', 'business']);
const extensionReasons = Object.freeze(['fixture-complexity', 'fixture-volume', 'fixture-validation']);
const baseline = { version: 1, status: 'published', calendar: { basis: 'UTC', closedDates: [] },
    rules: Object.fromEntries(kinds.map(kind => [kind, { basis: 'calendar', days: 30, extensionDays: 0 }])) };
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function exact(value, keys) {
    if (!object(value) ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
        fail(422, 'INVALID_POLICY_FIELDS', 'Use only the supported synthetic policy fields.');
}
const validDay = (value) => typeof value === 'string' && /^[0-9]{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function validate(rules, closedDates) {
    exact(rules, kinds);
    if (!Array.isArray(closedDates) || closedDates.length > 64 || !closedDates.every(validDay) || new Set(closedDates).size !== closedDates.length)
        fail(422, 'INVALID_POLICY_CALENDAR', 'Use at most 64 distinct fictional closed dates in YYYY-MM-DD format.');
    const normalized = {};
    for (const kind of kinds) {
        const rule = rules[kind];
        exact(rule, ['basis', 'days', 'extensionDays']);
        if ((rule.basis !== 'calendar' && rule.basis !== 'business') || !int(rule.days, 1, 365) || !int(rule.extensionDays, 0, 90))
            fail(422, 'INVALID_POLICY_RULE', 'Each rule needs 1–365 base days and 0–90 extension days in its calendar basis.');
        normalized[kind] = { basis: rule.basis, days: rule.days, extensionDays: rule.extensionDays };
    }
    return { calendar: { basis: 'UTC', closedDates: closedDates.slice().sort() }, rules: normalized };
}
function addDays(from, days, basis, closedDates = []) {
    if (rust.enabled)
        return rust.addDays(from, days, basis, closedDates);
    const d = new Date(from.slice(0, 10) + 'T00:00:00Z'), exclusions = new Set(closedDates);
    for (let count = 0; count < days;) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (basis === 'calendar' || (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !exclusions.has(d.toISOString().slice(0, 10))))
            count++;
    }
    return d.toISOString().slice(0, 10);
}
function ledger(state) { return state.rightsDeadlinePolicy ?? { revision: 0, activeVersion: 1, versions: [baseline], draft: null }; }
function active(state) { const p = ledger(state), version = p.versions.find(v => v.version === p.activeVersion); if (!version)
    throw Error('Missing active deadline policy version.'); return version; }
function pin(state, kind, receivedAt, legacyDays) {
    const p = active(state), rule = p.rules[kind];
    if (p.version > 1 && legacyDays !== undefined)
        fail(409, 'PUBLISHED_POLICY_REQUIRED', 'A published rule now controls this deadline. Reload before retrying.');
    const days = legacyDays ?? rule.days;
    const dueDate = addDays(receivedAt, days, rule.basis, p.calendar.closedDates);
    const clockPolicy = { version: p.version, days, unit: rule.basis === 'business' ? 'UTC business days' : 'UTC calendar days' };
    if (p.version > 1)
        Object.assign(clockPolicy, { basis: rule.basis, extensionDays: rule.extensionDays,
            closedDates: rule.basis === 'business' ? p.calendar.closedDates.slice() : [], source: 'published' });
    return { dueDate, originalDueDate: dueDate, clockPolicy };
}
function view(state, account) {
    const { revision, activeVersion, versions, draft } = structuredClone(ledger(state));
    function safe({ authorAccount, reviewerAccount, ...version }) {
        return { ...version, ...(version.status === 'published' ? {} : { ownDraft: authorAccount === account }) };
    }
    return { mode: 'fictional-rules-only', bases, kinds, revision, activeVersion,
        versions: versions.map(safe), draft: draft ? safe(draft) : null };
}
function mutate(state, actor, account, action, body, event) {
    if (!account)
        fail(404, 'POLICY_UNAVAILABLE', 'Deadline configuration requires an isolated staff session.');
    if (!['draft', 'submit', 'return', 'publish'].includes(action))
        fail(404, 'NOT_FOUND', 'Deadline policy action not found.');
    exact(body, action === 'draft' ? ['expectedRevision', 'rules', 'closedDates'] : ['expectedRevision']);
    const p = state.rightsDeadlinePolicy ??= structuredClone(ledger(state));
    if (!int(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER))
        fail(422, 'REVISION_REQUIRED', 'Provide the current deadline policy revision.');
    if (body.expectedRevision !== p.revision)
        fail(409, 'STALE_POLICY', 'This policy changed. Reload before retrying.');
    const draft = p.draft, authorAction = ['draft', 'submit'].includes(action);
    if (authorAction && actor !== 'analyst' || !authorAction && actor !== 'reviewer')
        fail(403, 'INDEPENDENT_POLICY_ROLE', 'Deadline authoring requires an analyst; decisions require an independent reviewer.');
    if (action === 'draft') {
        if (draft && (draft.status !== 'draft' || draft.authorAccount !== account))
            fail(409, 'DRAFT_UNAVAILABLE', 'Only the original author can edit an unsubmitted policy draft.');
        p.draft = { ...(draft ?? { id: (0, node_crypto_1.randomUUID)(), version: p.activeVersion + 1, authorAccount: account }), ...validate(body.rules, body.closedDates), status: 'draft' };
    }
    else if (action === 'submit') {
        if (!draft || draft.status !== 'draft' || draft.authorAccount !== account)
            fail(409, 'DRAFT_UNAVAILABLE', 'Only the original author can submit the open draft.');
        if (JSON.stringify([draft.rules, draft.calendar]) === JSON.stringify([active(state).rules, active(state).calendar]))
            fail(422, 'UNCHANGED_POLICY', 'Update at least one fictional rule or closed date before submitting.');
        draft.status = 'review';
    }
    else {
        if (!draft || draft.status !== 'review')
            fail(409, 'POLICY_REVIEW_REQUIRED', 'Submit a draft before making a policy decision.');
        if (draft.authorAccount === account)
            fail(403, 'INDEPENDENT_POLICY_REVIEW', 'A different account must decide this version.');
        if (action === 'return')
            draft.status = 'draft';
        else {
            p.versions.push({ ...draft, status: 'published', reviewerAccount: account, publishedAt: new Date().toISOString() });
            p.activeVersion = draft.version;
            p.draft = null;
        }
    }
    p.revision++;
    const changed = p.draft ?? draft;
    if (!changed)
        throw Error('Missing changed deadline policy version.');
    event(state, actor, 'rights.deadline-policy.' + action, null, changed.id, { version: changed.version, revision: p.revision, activeVersion: p.activeVersion });
    return view(state, account);
}
module.exports = { kinds, bases, extensionReasons, addDays, pin, active, view, mutate };
