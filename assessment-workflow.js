'use strict';
const engineModule = require("./workflow-engine");
const { createWorkflowEngine } = engineModule;
const definition = {
    id: 'assessment-review',
    initial: 'draft',
    states: [
        { id: 'draft', label: 'Draft' },
        { id: 'in-review', label: 'In review' },
        { id: 'approved', label: 'Approved' },
        { id: 'returned', label: 'Returned for changes' }
    ],
    transitions: [
        { id: 'submit', from: 'draft', to: 'in-review', roles: ['initiator'], requiredFields: ['summary', 'safeguards'] },
        { id: 'resubmit', from: 'returned', to: 'in-review', roles: ['initiator'], requiredFields: ['summary', 'safeguards'] },
        { id: 'approve', from: 'in-review', to: 'approved', roles: ['reviewer'], independent: true },
        { id: 'return', from: 'in-review', to: 'returned', roles: ['reviewer'], independent: true, requiredFields: ['reason'] }
    ]
};
const trust = { analyst: { id: 'analyst', role: 'initiator' }, reviewer: { id: 'reviewer', role: 'reviewer' } };
const display = { draft: 'draft', 'in-review': 'in_review', approved: 'approved', returned: 'rejected' };
function engineFor(state) {
    return createWorkflowEngine({ load: () => state.assessmentWorkflow, save: snapshot => { state.assessmentWorkflow = snapshot; } });
}
function initialize(state, definitionId) {
    const engine = engineFor(state);
    if (!engine.getDefinition(definitionId)) {
        const result = engine.publish({ actor: { id: 'system-publisher', role: 'publisher' }, definition: { ...definition, id: definitionId }, expectedVersion: 0 });
        if (!result.ok)
            throw Error('Unable to install the built-in assessment workflow.');
    }
    return engine;
}
function instanceFor(state, a) {
    const instance = engineFor(state).getInstance(a.workflowInstanceId);
    if (!instance || instance.definitionId !== a.routing.workflowId || a.workflowDefinitionVersion !== instance.definitionVersion || a.workflowRevision !== instance.revision || display[instance.state] !== a.status)
        throw Error('Assessment workflow linkage is inconsistent.');
    return instance;
}
function metadata(a, instance) {
    a.workflowInstanceId = instance.id;
    a.workflowDefinitionVersion = instance.definitionVersion;
    a.workflowRevision = instance.revision;
}
function start(state, a, legacy = false) {
    const result = initialize(state, a.routing.workflowId).start({ actor: trust.analyst, definitionId: a.routing.workflowId, title: 'Assessment ' + a.id });
    if (!result.ok)
        throw Error('Unable to open the assessment workflow.');
    if (!legacy || a.status === 'draft') {
        metadata(a, result.instance);
        return result.event;
    }
    // A one-time baseline records the old app status without fabricating historical
    // workflow transition steps. Past app decisions remain in the original audit.
    const instance = state.assessmentWorkflow?.instances.find(x => x.id === result.instance.id);
    if (!instance)
        throw Error('Assessment workflow linkage is inconsistent.');
    const pinnedState = Object.keys(display).find(k => display[k] === a.status);
    if (!pinnedState || a.submittedBy !== 'analyst' ||
        (['approved', 'rejected'].includes(a.status) && a.decisionBy !== 'reviewer'))
        throw Error('Legacy assessment cannot be safely migrated.');
    instance.state = pinnedState;
    instance.legacyBaseline = { status: a.status, assessmentRevision: a.revision, submittedBy: a.submittedBy, decisionBy: a.decisionBy };
    if (a.status === 'approved' || a.status === 'rejected') {
        instance.lastActorId = 'reviewer';
        instance.contributors = [];
    }
    metadata(a, instance);
    return result.event;
}
function advance(state, a, actor, action, fields) {
    const instance = instanceFor(state, a);
    const transition = action === 'submit' && instance.state === 'returned' ? 'resubmit' : action === 'reject' ? 'return' : action;
    const result = engineFor(state).advance({ actor: trust[actor], instanceId: instance.id, transitionId: transition,
        expectedRevision: instance.revision, fields });
    if (result.ok) {
        metadata(a, result.instance);
        a.status = display[result.instance.state];
    }
    return result;
}
function isApproved(state, a) {
    const instance = instanceFor(state, a);
    const step = instance.steps.at(-1);
    return instance.state === 'approved' && a.submittedBy === 'analyst' && a.decisionBy === 'reviewer' &&
        (step?.transitionId === 'approve' && step.actorId === 'reviewer' ||
            !step && instance.legacyBaseline?.status === 'approved' && instance.legacyBaseline.decisionBy === 'reviewer');
}
module.exports = { start, advance, isApproved, instanceFor };
