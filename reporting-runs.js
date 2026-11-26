'use strict';
const node_crypto_1 = require("node:crypto");
const reporting = require("./reporting");
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const routePattern = /^\/api\/reporting(?:\/export|\/(runs)(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(\/export)?)?)?$/;
const limits = Object.freeze({ retentionDays: 30, maxRuns: 30, maxRunBytes: 262144, maxWorkspaceBytes: 1048576 });
const ttl = limits.retentionDays * 86400000;
const keys = ['dataset', 'workflow', 'stage', 'outcome', 'group', 'from', 'to'];
function fail(status, code, message) { throw Object.assign(Error(message), { status, code }); }
function invalid(message) { return fail(422, 'INVALID_REPORT_RUN', message); }
const utf8 = (value) => Buffer.byteLength(value, 'utf8');
function active(state, now) {
    return (state.reportRuns ?? []).filter(row => Date.parse(row.expiresAt) > now);
}
function list(state, now = Date.now()) {
    const rows = active(state, now);
    return { limits, runs: rows.slice().reverse().map(({ id, generatedAt, expiresAt, filters, counts }) => ({ id, generatedAt, expiresAt, filters, counts })) };
}
function create(state, audit, body, mode, { now = Date.now() } = {}) {
    if (!record(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'filters'))
        invalid('Provide only a filters object.');
    const { filters } = body;
    if (!record(filters) || Object.keys(filters).some(k => !keys.includes(k)))
        invalid('Use supported report filters only.');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if ((key === 'from' || key === 'to') && value === null)
            continue;
        if (typeof value !== 'string')
            invalid('Each report filter must be a string, or null for an unset date.');
        params.set(key, value);
    }
    const generatedAt = new Date(now).toISOString();
    const { model } = reporting.report(state, audit, params, { mode, generatedAt });
    const run = { id: (0, node_crypto_1.randomUUID)(), expiresAt: new Date(now + ttl).toISOString() };
    const json = JSON.stringify({ ...model, run }, null, 2) + '\n', csv = reporting.csv(model);
    const bytes = utf8(json) + utf8(csv);
    if (bytes > limits.maxRunBytes)
        fail(413, 'REPORT_RUN_TOO_LARGE', 'This report is too large to pin. Narrow the date range or choose a coarser grouping.');
    const held = active(state, now);
    const entry = { ...run, generatedAt, filters: model.filters, counts: model.counts, json, csv, bytes };
    held.push(entry);
    let totalBytes = held.reduce((total, row) => total + row.bytes, 0);
    while (held.length > limits.maxRuns || totalBytes > limits.maxWorkspaceBytes)
        totalBytes -= held.shift().bytes;
    state.reportRuns = held;
    return Buffer.from(json, 'utf8');
}
function read(state, id, format, now = Date.now()) {
    const run = active(state, now).find(x => x.id === id);
    if (!run)
        fail(404, 'REPORT_RUN_NOT_FOUND', 'That pinned report is no longer available in this workspace.');
    return Buffer.from(format === 'csv' ? run.csv : run.json, 'utf8');
}
function query(params, exporting) {
    for (const key of new Set(params.keys()))
        if (!exporting || key !== 'format' || params.getAll(key).length !== 1)
            invalid('Pinned reports use their saved filters. Only an export format is accepted on downloads.');
    const format = params.get('format') ?? 'json';
    if (format !== 'json' && format !== 'csv')
        invalid('Export format must be JSON or CSV.');
    return format;
}
module.exports = { limits, routePattern, list, create, read, query };
