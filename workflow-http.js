'use strict';
const fs = require("node:fs");
const path = require("node:path");
const node_crypto_1 = require("node:crypto");
const engineModule = require("./workflow-engine");
const { createWorkflowEngine, syntheticDefinition } = engineModule;
const { hasLegacySnapshot, parseJsonBytes } = require('./durable-storage');
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const actorFor = {
    analyst: { id: 'analyst', role: 'initiator' },
    reviewer: { id: 'reviewer', role: 'reviewer' },
    publisher: { id: 'publisher', role: 'publisher' },
};
const recipe = [
    { ...syntheticDefinition, label: 'Synthetic independent review' },
    { id: 'synthetic-inventory-check', label: 'Synthetic inventory check', initial: 'open',
        states: [{ id: 'open', label: 'Open' }, { id: 'ready', label: 'Ready' }, { id: 'done', label: 'Done' }],
        transitions: [
            { id: 'record-check', from: 'open', to: 'ready', roles: ['initiator'], requiredFields: ['checkSummary'] },
            { id: 'close-check', from: 'ready', to: 'done', roles: ['reviewer'], independent: true, requiredFields: ['decision'] }
        ] },
];
function workflowActor(key, account) {
    const actor = key !== undefined && Object.hasOwn(actorFor, key) ? actorFor[key] : null;
    return actor && (account ? { id: account, role: actor.role, legacyId: actor.id } : actor);
}
function openWorkflowHttp(file, { storage } = {}) {
    let active;
    function command(apply, checkSession) {
        if (!storage)
            return apply();
        return storage.write('workflow', (snapshot, save) => {
            checkSession?.();
            if (snapshot === undefined && hasLegacySnapshot(file))
                throw Error('Legacy workflow state exists; migrate it explicitly before enabling SQLite.');
            active = { snapshot, save };
            try {
                return apply();
            }
            finally {
                active = undefined;
            }
        });
    }
    if (storage && hasLegacySnapshot(file) && storage.read('workflow') === undefined)
        throw Error('Legacy workflow state exists; migrate it explicitly before enabling SQLite.');
    const engine = createWorkflowEngine({
        load() {
            if (active)
                return active.snapshot;
            if (storage) {
                const state = storage.read('workflow');
                if (state === undefined && hasLegacySnapshot(file))
                    throw Error('Legacy workflow state exists; migrate it explicitly before enabling SQLite.');
                return state;
            }
            try {
                return parseJsonBytes(fs.readFileSync(file));
            }
            catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                    throw error;
            }
        },
        save(snapshot) {
            if (active)
                return active.save(snapshot);
            if (storage)
                throw Error('Write outside storage transaction.');
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            const temp = file + '.' + (0, node_crypto_1.randomUUID)() + '.tmp';
            try {
                fs.writeFileSync(temp, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600, flush: true });
                fs.renameSync(temp, file);
            }
            finally {
                if (fs.existsSync(temp))
                    fs.unlinkSync(temp);
            }
        },
    });
    const get = (p, mode = 'synthetic-demo', key, account) => {
        if (p[0] === 'studio' && (p.length === 1 || p.length === 2)) {
            const actor = workflowActor(key, account);
            if (mode !== 'synthetic-demo' && !actor)
                return { status: 403, value: { error: 'This workspace role has no workflow studio access.' } };
            const model = engine.catalog(actor, p[1]);
            if (p.length === 2 && !model.selected)
                return { status: 404, value: { error: 'Workflow instance not found.' } };
            return { status: 200, value: { mode, actor: actor ? { id: actor.id, role: actor.role } : null, recipes: recipe, ...model } };
        }
        if (p.length === 1 && p[0] === 'audit')
            return { status: 200, value: { mode, audit: engine.audit() } };
        let record;
        if (p[0] === 'definitions' && (p.length === 2 || p.length === 3)) {
            if (p.length === 3 && !/^[1-9][0-9]*$/.test(p[2]))
                return { status: 400, value: { error: 'Invalid definition version.' } };
            record = engine.getDefinition(p[1], p.length === 3 ? Number(p[2]) : undefined);
        }
        else if (p[0] === 'instances' && p.length === 2)
            record = engine.getInstance(p[1]);
        return record ? { status: 200, value: record } : { status: 404, value: { error: 'Workflow resource not found.' } };
    };
    const post = (p, key, body, account, checkSession) => {
        const actor = workflowActor(key, account);
        if (!actor)
            return { status: 403, value: { error: 'A permitted local workflow identity is required.' } };
        if (!record(body))
            return { status: 400, value: { error: 'Send an object.' } };
        let value;
        if (p.length === 1 && p[0] === 'definitions')
            value = command(() => engine.publish({ actor, definition: body.definition, expectedVersion: body.expectedVersion }), checkSession);
        else if (p.length === 1 && p[0] === 'instances')
            value = command(() => engine.start({ actor, definitionId: body.definitionId, version: body.version, title: body.title }), checkSession);
        else if (p.length === 3 && p[0] === 'instances' && p[2] === 'transitions')
            value = command(() => engine.advance({ actor, instanceId: p[1], transitionId: body.transitionId, expectedRevision: body.expectedRevision, fields: body.fields }), checkSession);
        else
            return { status: 404, value: { error: 'Workflow route not found.' } };
        const statuses = {
            INVALID_ACTOR: 403, ROLE_REQUIRED: 403, INDEPENDENCE_REQUIRED: 403,
            DEFINITION_NOT_FOUND: 404, INSTANCE_NOT_FOUND: 404,
            STALE_DEFINITION: 409, STALE_REVISION: 409, TRANSITION_NOT_AVAILABLE: 409,
        };
        const status = value.ok ? 200 : statuses[value.code] ?? 422;
        return { status, value };
    };
    return { get, post };
}
module.exports = { openWorkflowHttp };
