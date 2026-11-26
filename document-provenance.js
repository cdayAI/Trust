'use strict';
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const id = /^[a-z][a-z0-9-]{0,47}$/;
const isAccount = (value) => typeof value === 'string' && id.test(value);
const authorActions = new Set(['create', 'revise', 'edit', 'submit', 'attachment-upload', 'attachment-remove']);
const cap = 64;
function failure(status, code, message) { throw Object.assign(Error(message), { status, code }); }
function start(account) {
    return { schemaVersion: 1, authorAccount: account, contributors: [account], submittedBy: null, publishedBy: null };
}
function tracked(record, version) {
    if (!object(record) || record.schemaVersion !== 1 || !Array.isArray(record.contributors) || !record.contributors.length || record.contributors.length > cap ||
        new Set(record.contributors).size !== record.contributors.length || !record.contributors.every(isAccount) ||
        !isAccount(record.authorAccount) || !record.contributors.includes(record.authorAccount) ||
        (version.status === 'draft' ? record.submittedBy !== null : !isAccount(record.submittedBy) || !record.contributors.includes(record.submittedBy)) ||
        (version.status === 'published' ? (!isAccount(record.publishedBy) || record.contributors.includes(record.publishedBy)) : record.publishedBy !== null))
        return undefined;
    return { schemaVersion: 1, authorAccount: record.authorAccount, contributors: [...record.contributors],
        submittedBy: record.submittedBy, publishedBy: record.publishedBy };
}
// Prior isolated commits stamped verification-backed account IDs onto their audit
// events. Never infer identity from today's seat, a role label, or a partial log.
function recover(state, document, version) {
    let record, stage, contentHash;
    const names = new Set();
    let sequence;
    for (const row of state.audit) {
        if (record && (sequence === undefined || row.sequence !== sequence + 1))
            return undefined;
        sequence = row.sequence;
        if (row.entityId !== document.id || !row.details || row.details.versionId !== version.id ||
            typeof row.action !== 'string' || !row.action.startsWith('governance-documents.'))
            continue;
        const action = row.action.slice('governance-documents.'.length);
        if (authorActions.has(action)) {
            if (row.actor !== 'analyst' || !isAccount(row.account) || !Number.isSafeInteger(row.sequence))
                return undefined;
            if (action === 'create' || action === 'revise') {
                if (record || action !== (version.number === 1 ? 'create' : 'revise'))
                    return undefined;
                stage = 'draft';
                record = start(row.account);
                contentHash = row.details.hash;
            }
            else {
                if (!record || stage !== 'draft')
                    return undefined;
                if (!record.contributors.includes(row.account)) {
                    if (record.contributors.length >= cap)
                        return undefined;
                    record.contributors.push(row.account);
                }
                if (action === 'edit' || action === 'submit')
                    contentHash = row.details.hash;
                if (action === 'submit') {
                    stage = 'review';
                    record.submittedBy = row.account;
                }
                if (action === 'attachment-upload') {
                    const key = row.details.attachmentId;
                    if (typeof key !== 'string' || !key || names.has(key))
                        return undefined;
                    names.add(key);
                }
                if (action === 'attachment-remove' && (typeof row.details.attachmentId !== 'string' || !names.delete(row.details.attachmentId)))
                    return undefined;
            }
        }
        else if (action === 'return') {
            if (!record || stage !== 'review' || row.actor !== 'reviewer' || !isAccount(row.account) || record.contributors.includes(row.account))
                return undefined;
            stage = 'draft';
            record.submittedBy = null;
        }
        else if (action === 'publish')
            return undefined;
    }
    const actual = version.attachments ?? [];
    if (!record || stage !== version.status || typeof contentHash !== 'string' || contentHash !== version.contentHash ||
        names.size !== actual.length || actual.some(row => !names.has(row.id)))
        return undefined;
    return tracked(record, version);
}
function provenance(state, document, version) {
    if (Object.hasOwn(version, 'accountProvenance'))
        return tracked(version.accountProvenance, version);
    return ['draft', 'review'].includes(version.status) ? recover(state, document, version) : undefined;
}
function reviewStatus(state, document, version, actor, account) {
    if (!isAccount(account) || !['analyst', 'reviewer'].includes(actor) || version.status === 'published')
        return undefined;
    const record = provenance(state, document, version);
    return !record ? 'unattributed' : actor === 'reviewer' && record.contributors.includes(account) ? 'contributor' : 'eligible';
}
function acting(state, document, version, actor, account, reviewCode = 'INDEPENDENT_REVIEW_REQUIRED') {
    if (!isAccount(account))
        failure(403, 'DOCUMENT_ACCOUNT_REQUIRED', 'An authenticated local staff account is required.');
    const record = provenance(state, document, version);
    if (!record)
        failure(409, 'DOCUMENT_AUTHORSHIP_UNATTRIBUTED', 'Historical authorship cannot be verified. Keep this edition for history and author a new document.');
    if (actor === 'reviewer' && record.contributors.includes(account))
        failure(403, reviewCode, 'An account that contributed to this edition cannot review it.');
    return record;
}
function contribute(record, account) {
    if (!record.contributors.includes(account)) {
        if (record.contributors.length >= cap)
            failure(409, 'DOCUMENT_CONTRIBUTOR_LIMIT', 'This edition has reached its local contributor limit.');
        record.contributors.push(account);
    }
}
module.exports = { isAccount, start, reviewStatus, acting, contribute };
