'use strict';
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const accountPattern = /^[a-z][a-z0-9-]{0,47}$/;
const operations = Object.freeze({
    enable: { label: 'Enable workspace access', reason: ['access-review', 'assignment-restored'] },
    disable: { label: 'Disable workspace access', reason: ['access-review', 'assignment-ended'] },
    revoke: { label: 'Revoke workspace sessions', reason: ['access-review', 'session-reset'] }
});
const reasons = Object.freeze({
    'access-review': 'Access review',
    'assignment-restored': 'Assignment restored',
    'assignment-ended': 'Assignment ended',
    'session-reset': 'Session reset'
});
function failure(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function validRow(row) {
    return object(row) && typeof row.id === 'string' && accountPattern.test(row.id) &&
        typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 1 && typeof row.disabled === 'boolean';
}
function records(state) {
    const board = state.identityAdministration;
    if (board === undefined)
        return [];
    if (!object(board) || board.schemaVersion !== 1 || !Array.isArray(board.members) || !board.members.every(validRow) ||
        new Set(board.members.map(row => row.id)).size !== board.members.length)
        throw Error('Invalid identity administration record.');
    return board.members;
}
function record(state, id) {
    const current = records(state).find(row => row.id === id);
    return current ? { revision: current.revision, disabled: current.disabled } : { revision: 0, disabled: false };
}
function view(state, seats, at) {
    const data = records(state);
    const byMember = new Map(data.map(row => [row.id, row]));
    const members = seats.map(seat => {
        const row = byMember.get(seat.id);
        const status = seat.configuredDisabled ? 'configuration-disabled' :
            seat.validUntil !== null && at >= seat.validUntil ? 'expired' : row?.disabled ? 'disabled' : 'active';
        const allowed = seat.role === 'identity-admin' ? [] : status === 'active' ? ['disable', 'revoke'] : status === 'disabled' ? ['enable'] : [];
        return { id: seat.id, role: seat.role, status, revision: row?.revision ?? 0, allowed };
    });
    const audit = state.audit.filter(e => e.actor === 'identity-admin' && typeof e.action === 'string' && e.action.startsWith('identity-admin.'))
        .slice(-50).reverse().map(e => ({ action: e.action.slice(15), at: e.at, actor: e.details.admin, target: e.entityId,
        reason: e.details.reason, revision: e.details.revision }));
    return { members, audit, operations, reasons };
}
function change(state, seats, at, admin, body, audit) {
    const authority = seats.find(seat => seat.id === admin && seat.role === 'identity-admin');
    if (!authority || authority.configuredDisabled || (authority.validUntil !== null && at >= authority.validUntil))
        failure(403, 'IDENTITY_AUTHORITY_REQUIRED', 'An active identity administrator is required.');
    if (!object(body) || Object.keys(body).length !== 4 ||
        !['target', 'operation', 'reason', 'expectedRevision'].every(k => Object.hasOwn(body, k)) ||
        typeof body.target !== 'string' || !accountPattern.test(body.target) || typeof body.operation !== 'string' ||
        !Object.hasOwn(operations, body.operation) || typeof body.reason !== 'string' || !operations[body.operation].reason.includes(body.reason) ||
        typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)
        failure(422, 'INVALID_IDENTITY_CHANGE', 'Choose an account, allowed operation, reason and current revision.');
    const member = seats.find(seat => seat.id === body.target);
    if (!member)
        failure(404, 'MEMBER_NOT_FOUND', 'Account is not provisioned for this workspace.');
    if (member.role === 'identity-admin' || member.id === admin)
        failure(403, 'ADMIN_SEAT_PROTECTED', 'The identity administrator cannot be changed from this screen.');
    const current = record(state, member.id);
    if (current.revision !== body.expectedRevision)
        failure(409, 'IDENTITY_STALE', 'Account access changed. Reload the workspace roster.');
    if (member.configuredDisabled || (member.validUntil !== null && at >= member.validUntil))
        failure(409, 'PROVISIONING_RESTRICTED', 'This account is disabled or expired in provisioning.');
    if ((body.operation === 'enable') !== current.disabled)
        failure(409, 'IDENTITY_TRANSITION', 'That operation is not available for the current access state.');
    const next = { id: member.id, revision: current.revision + 1, disabled: body.operation === 'disable' };
    if (!Number.isSafeInteger(next.revision))
        throw Error('Account access generation overflow.');
    state.identityAdministration = { schemaVersion: 1, members: [...records(state).filter(row => row.id !== member.id), next] };
    audit(state, 'identity-admin', 'identity-admin.' + body.operation, null, member.id, { admin, reason: body.reason, revision: next.revision });
    return view(state, seats, at);
}
function applySuspensionPlan(state, targets) {
    const current = new Map(records(state).map(row => [row.id, row]));
    const changes = targets.map(({ account, before, after }) => {
        const row = current.get(account) ?? { revision: 0, disabled: false };
        if (!accountPattern.test(account) || row.disabled || row.revision !== before.revision || before.disabled !== false ||
            !Number.isSafeInteger(after.revision) || after.revision !== row.revision + 1 || after.disabled !== true)
            failure(409, 'IDENTITY_STALE', 'An account changed before suspension. No membership was changed.');
        return { id: account, revision: after.revision, disabled: true };
    });
    for (const row of changes)
        current.set(row.id, row);
    state.identityAdministration = { schemaVersion: 1, members: [...current.values()] };
}
module.exports = { record, view, change, applySuspensionPlan };
