'use strict';
const { view: queueView } = require('./work-queue');
const { model: myWork } = require('./my-work');
const empty = () => ({ total: 0, overdue: 0, dueToday: 0, upcoming: 0, undated: 0 });
function count(rows) {
    const summary = empty();
    for (const row of rows) {
        summary.total++;
        if (row.timing === 'overdue')
            summary.overdue++;
        else if (row.timing === 'due-today')
            summary.dueToday++;
        else if (row.timing === 'upcoming')
            summary.upcoming++;
        else
            summary.undated++;
    }
    return summary;
}
function dashboard(state, { mode, actor, selection, views }, params, asOf = new Date().toISOString().slice(0, 10)) {
    if (params.size)
        throw Object.assign(new Error('Workspace home does not accept filters.'), { status: 422 });
    const enabled = new Set(views);
    const demo = mode === 'synthetic-demo';
    // The restricted case seat must never compute or return workspace-level aggregates.
    const personal = selection ? myWork(state, selection, views, new URLSearchParams(), undefined, asOf).tasks : null;
    const queue = enabled.has('queue') ? queueView(state, new URLSearchParams(), asOf) : null;
    const workspace = queue?.tasks.filter(row => enabled.has(row.destination.view)) ?? [];
    const demoAssigned = () => queue ? workspace.filter(row => row.owner === actor) :
        queueView(state, new URLSearchParams({ owner: actor }), asOf).tasks.filter(row => enabled.has(row.destination.view));
    const assigned = personal ?? demoAssigned();
    let triage = null;
    if (queue) {
        const groups = new Map();
        for (const task of workspace) {
            if (!groups.has(task.workflow))
                groups.set(task.workflow, empty());
            const group = groups.get(task.workflow);
            group.total++;
            if (task.timing === 'overdue')
                group.overdue++;
            if (task.timing === 'due-today')
                group.dueToday++;
        }
        triage = { ...count(workspace), workflows: [...groups.entries()].sort((a, b) => b[1].overdue - a[1].overdue ||
                b[1].dueToday - a[1].dueToday || b[1].total - a[1].total || a[0].localeCompare(b[0]))
                .map(([id, { total, overdue, dueToday }]) => ({ id, label: queue.workflowLabels[id], total, overdue, dueToday })) };
    }
    // Deliberately expose only aggregate display values, no task/record objects or keys.
    return { mode, asOf, assigned: count(assigned), ...(triage ? { triage } : {}), scope: demo ? 'demo-role' : 'assigned-seat' };
}
module.exports = { dashboard };
