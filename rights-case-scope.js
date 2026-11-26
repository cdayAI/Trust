'use strict';
const node_crypto_1 = require("node:crypto");
const identity = require("./identity-admin");
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const accountId = /^[a-z][a-z0-9-]{0,47}$/;
const caseId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fingerprint = /^[a-f0-9]{64}$/;
const reasons = ['case-assignment', 'coverage-change', 'scope-review', 'assignment-ended'];
const lease = 30 * 86400000, capacity = 1000;
const is = (pattern, x) => typeof x === 'string' && pattern.test(x);
const exact = (value, keys) => object(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
function failure(status, code, message) { throw Object.assign(Error(message), { status, code }); }
function missing() { return failure(404, 'RIGHTS_CASE_NOT_FOUND', 'Rights case not found.'); }
function provision(isolated) {
    const ids = isolated?.rightsCaseScopeWorkspaces;
    if (ids === undefined)
        return new Set();
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        !isolated || !Array.isArray(isolated.workspaces) || !Array.isArray(isolated.accounts) || !ids.every((id) => typeof id === 'string'))
        throw Error('Rights case delegation requires explicit isolated workspaces.');
    for (const id of ids) {
        if (!isolated.workspaces.some(w => w.id === id))
            throw Error('Rights case delegation names an unknown workspace.');
        const accounts = isolated.accounts;
        const seats = new Map(accounts.filter(a => Object.hasOwn(a.memberships ?? {}, id)).map(a => [a.memberships[id], a.id]));
        if (!seats.has('analyst') || !seats.has('case-operator') || seats.get('case-operator') === seats.get('analyst'))
            throw Error('Rights case delegation needs separate analyst and case-operator accounts.');
    }
    return new Set(ids);
}
const empty = () => ({ version: 1, delegations: [] });
function book(state) {
    const scope = state.rightsCaseAccountScope;
    if (scope === undefined)
        return new Map();
    if (!object(scope) || scope.version !== 1 || !Array.isArray(scope.delegations) || scope.delegations.length > capacity)
        throw Error('Invalid rights case delegation state.');
    const byCase = new Map();
    for (const record of scope.delegations) {
        if (!object(record) || !is(caseId, record.id) || byCase.has(record.id) || !is(accountId, record.account) ||
            !is(fingerprint, record.binding) || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 1 ||
            typeof record.revoked !== 'boolean')
            throw Error('Invalid rights case delegation state.');
        byCase.set(record.id, record);
    }
    return byCase;
}
function assignmentHistory(state) {
    const owners = new Map();
    for (const e of state.audit)
        if (e.action === 'rights.case.assign')
            owners.set(e.entityId, e.id);
    return owners;
}
function eligible(state, ctx, id) {
    const seat = ctx.roster.find(x => x.role === 'case-operator' && (id === undefined || x.id === id));
    if (!seat || seat.configuredDisabled || (seat.validUntil !== null && ctx.at >= seat.validUntil))
        return undefined;
    const membership = identity.record(state, seat.id);
    return membership.disabled ? undefined : { seat, identityRevision: membership.revision };
}
function keyFor(state, ctx, row, record, owners) {
    const member = eligible(state, ctx, record.account);
    if (row?.owner !== 'case-operator' || !member)
        return undefined;
    return (0, node_crypto_1.createHash)('sha256').update(JSON.stringify([
        row.id, owners.get(row.id) ?? null, member.seat.id, member.identityRevision, member.seat.provisioning
    ])).digest('hex');
}
function status(state, ctx, row, record, owners) {
    if (!record)
        return 'not-delegated';
    if (record.revoked)
        return 'revoked';
    if (keyFor(state, ctx, row, record, owners) !== record.binding)
        return 'stale';
    return ctx.at >= record.expiresAt ? 'expired' : 'active';
}
function viewState(state, ctx) {
    if (state.rightsCaseAccountScope === undefined && !ctx.rightsEnabled)
        return state;
    if (!ctx.rightsEnabled)
        return { ...state, rightsCases: [] };
    const current = eligible(state, ctx, ctx.role === 'case-operator' ? ctx.account : undefined);
    if (!current)
        return { ...state, rightsCases: [] };
    const grants = book(state), owners = assignmentHistory(state);
    const cases = (state.rightsCases ?? []).filter(row => {
        const r = grants.get(row.id);
        return r?.account === current.seat.id && status(state, ctx, row, r, owners) === 'active';
    });
    return { ...state, rightsCases: cases };
}
function verifyTarget(state, ctx, id) {
    const row = viewState(state, ctx).rightsCases?.find(x => x.id === id && x.owner === 'case-operator');
    if (!row)
        missing();
}
function settings(state, ctx) {
    if (!ctx?.rightsEnabled || ctx.role !== 'analyst')
        return undefined;
    const seat = eligible(state, ctx), grants = book(state), owners = assignmentHistory(state);
    return { accounts: seat ? [seat.seat.id] : [], reasons,
        cases: (state.rightsCases ?? []).filter(row => row.owner === 'case-operator').map(row => {
            const record = grants.get(row.id);
            return { id: row.id, account: record?.account ?? null, expiresAt: record?.expiresAt ?? null,
                status: status(state, ctx, row, record, owners), canDelegate: !row.closedAt };
        }) };
}
// The snapshot revision already covers assignments/membership. Record only the
// delegation decisions that can change without a write as the clock advances.
function intakeTimeMarker(state, ctx) {
    if (!ctx.rightsEnabled)
        return null;
    const member = eligible(state, ctx);
    const expired = Array.from(book(state).values()).filter(row => ctx.at >= row.expiresAt).map(row => row.id);
    return [member?.seat.id ?? null, member?.seat.provisioning ?? null, member?.identityRevision ?? null, expired];
}
function write(state, ctx, id, body, event) {
    if (!ctx.rightsEnabled || ctx.role !== 'analyst')
        missing();
    const op = object(body) ? body.operation : undefined;
    if ((op !== 'delegate' && op !== 'revoke') ||
        !exact(body, op === 'delegate' ? ['operation', 'reason', 'account', 'expectedRevision'] : ['operation', 'reason', 'expectedRevision']) ||
        typeof body.reason !== 'string' || !reasons.includes(body.reason) || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 ||
        (op === 'delegate' && !is(accountId, body.account)))
        failure(422, 'INVALID_CASE_DELEGATION', 'Provide a current case revision, valid reason and exact local case-operator account.');
    const row = state.rightsCases?.find(x => x.id === id && x.owner === 'case-operator');
    if (!row)
        missing();
    if (body.expectedRevision !== row.revision)
        failure(409, 'STALE_CASE_DELEGATION', 'This case changed. Reload before retrying.');
    const grants = book(state), owners = assignmentHistory(state), current = grants.get(id);
    if (op === 'delegate') {
        if (row.closedAt)
            failure(409, 'CASE_CLOSED', 'Closed cases cannot establish new delegation.');
        if (status(state, ctx, row, current, owners) === 'active')
            failure(409, 'CASE_ALREADY_DELEGATED', 'This case already has an active delegation.');
        if (!current && grants.size >= capacity)
            failure(409, 'CASE_DELEGATION_LIMIT', 'This workspace has reached its delegation limit.');
        if (!is(accountId, body.account))
            failure(422, 'INVALID_CASE_DELEGATION', 'Provide a current case revision, valid reason and exact local case-operator account.');
        const binding = keyFor(state, ctx, row, { account: body.account }, owners);
        if (!binding)
            failure(422, 'CASE_DELEGATE_UNAVAILABLE', 'That local account is not an eligible case operator.');
        const expiresAt = ctx.at + lease;
        if (!Number.isSafeInteger(expiresAt))
            throw Error('Invalid case access expiry.');
        grants.set(id, { id, account: body.account, binding, expiresAt, revoked: false });
    }
    else {
        if (!current || current.revoked)
            failure(409, 'CASE_DELEGATION_UNAVAILABLE', 'There is no delegation to revoke.');
        current.revoked = true;
    }
    row.revision++;
    if (!Number.isSafeInteger(row.revision))
        throw Error('Case revision overflow.');
    row.updatedAt = new Date(ctx.at).toISOString();
    state.rightsCaseAccountScope = { version: 1, delegations: [...grants.values()] };
    event(state, ctx.role, 'rights.case.account-' + (op === 'delegate' ? 'delegated' : 'revoked'), null, id, {
        delegate: grants.get(id).account, reason: body.reason, revision: row.revision
    });
}
module.exports = { provision, empty, viewState, verifyTarget, settings, intakeTimeMarker, write };
