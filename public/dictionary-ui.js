'use strict';
const dictionaryPane = $('#dictionary-view'), dictionaryPath = '/api/dictionary';
async function refreshDictionary() {
    try {
        const data = await read(dictionaryPath);
        if (!dictionaryPane.hidden)
            renderDictionary(data);
    }
    catch (error) {
        if (!dictionaryPane.hidden)
            dictionaryPane.replaceChildren(el('p', error instanceof Error ? error.message : String(error), 'error'));
    }
}
function renderDictionary(data) {
    const intro = add(el('section'), heading('Governed data dictionary'), el('p', 'Review fictional typed terms and assign exact approved versions to inventory. Publishing a new version never changes existing pins.'));
    const exportLink = el('a', 'Export dictionary JSON', 'button quiet');
    exportLink.href = scopeUrl(dictionaryPath + '/export');
    exportLink.download = '';
    intro.append(exportLink);
    async function write(route, fields) {
        if (busy)
            return;
        busy = true;
        try {
            const next = await read(dictionaryPath + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor },
                body: JSON.stringify({ ...fields, expectedRevision: data.revision }) });
            if (!dictionaryPane.hidden) {
                renderDictionary(next);
                notice('Dictionary updated.');
            }
        }
        catch (error) {
            if (!dictionaryPane.hidden) {
                notice(error instanceof Error ? error.message : String(error), true);
                if (error instanceof Error && 'status' in error && error.status === 409)
                    await refreshDictionary();
            }
        }
        finally {
            busy = false;
        }
    }
    function form(parent, fields, label, send) {
        const f = add(el('form'), ...fields, button(label, 'submit'));
        f.onsubmit = event => { event.preventDefault(); send(Object.fromEntries(new FormData(f))); };
        parent.append(f);
    }
    if (actor === 'analyst') {
        const create = add(el('details'), el('summary', 'Draft a term'));
        form(create, [
            rightsSelect('Term type', 'type', Object.entries(data.types).map(([value, x]) => ({ value, label: x.label }))),
            labelled('Stable slug', 'slug', '', 'input'), labelled('Fictional title', 'title', '', 'input'),
            labelled('Fictional definition', 'definition', '', 'textarea')
        ], 'Create term draft', fields => write('/terms', fields));
        intro.append(create);
    }
    const terms = add(el('section'), heading('Terms and consumers'));
    if (!data.terms.length)
        terms.append(el('p', 'No governed terms yet.'));
    for (const term of data.terms) {
        const route = '/terms/' + term.id, latest = term.versions.at(-1);
        if (!latest)
            throw Error('Dictionary term is missing its version.');
        const row = add(el('article', undefined, 'module-record'), el('h3', latest.title), el('p', term.slug + ' · ' + data.types[term.type].label + (term.retiredAt ? ' · retired' : '')), el('p', 'Latest version ' + latest.number + ' · ' + latest.status + (term.activeVersion ? ' · approved version ' + term.activeVersion : '')), el('p', latest.definition));
        const actions = el('div');
        row.append(actions);
        const step = (label, operation, fields) => { const b = button(label, 'button', 'secondary'); b.onclick = () => write(route + '/' + operation, fields); actions.append(b); };
        if (!term.retiredAt) {
            if (actor === 'analyst' && latest.status === 'draft')
                step('Submit version', 'submit', { version: latest.number });
            if (actor === 'reviewer' && latest.status === 'review') {
                step('Approve version', 'approve', { version: latest.number });
                form(actions, [labelled('Return reason', 'reason', '', 'input')], 'Return version', x => write(route + '/return', { ...x, version: latest.number }));
            }
            if (actor === 'analyst' && !['draft', 'review'].includes(latest.status)) {
                const change = add(el('details'), el('summary', 'Draft next version'));
                form(change, [labelled('Fictional title', 'title', latest.title, 'input'), labelled('Fictional definition', 'definition', latest.definition)], 'Create next draft', x => write(route + '/revise', x));
                row.append(change);
                if (!term.consumers.length)
                    form(actions, [labelled('Retirement reason', 'reason', '', 'input')], 'Retire term', x => write(route + '/retire', x));
            }
            const options = data.inventory.filter(n => data.types[term.type].nodeTypes.includes(n.type) && !term.consumers.some(x => x.nodeId === n.id));
            if (actor === 'analyst' && term.activeVersion && options.length) {
                form(actions, [rightsSelect('Inventory consumer', 'nodeId', options.map(x => ({ value: x.id, label: x.name })))], 'Pin approved version', x => write(route + '/attach', { ...x, version: term.activeVersion, expectedMapRevision: data.mapRevision }));
            }
        }
        const impact = add(el('div'), el('h4', 'Consumer impact'));
        if (!term.consumers.length)
            impact.append(el('p', 'No active inventory references.'));
        for (const ref of term.consumers) {
            const link = add(el('p'), document.createTextNode(ref.nodeName + ' · pinned version ' + ref.version + ' '));
            if (actor === 'analyst') {
                const detach = button('Detach ' + ref.nodeName, 'button', 'secondary');
                detach.onclick = () => write(route + '/detach', { nodeId: ref.nodeId, version: ref.version, expectedMapRevision: data.mapRevision });
                link.append(detach);
            }
            impact.append(link);
        }
        const history = add(el('details'), el('summary', 'Version history'));
        for (const v of term.versions.slice().reverse()) {
            history.append(el('p', 'Version ' + v.number + ' · ' + v.status + ' · ' + v.title), el('p', v.definition));
            if (v.review?.reason)
                history.append(el('p', 'Internal return reason: ' + v.review.reason, 'hint'));
        }
        row.append(impact, history);
        terms.append(row);
    }
    dictionaryPane.replaceChildren(intro, terms);
}
$('#show-dictionary').onclick = () => switchView('dictionary');
$('#actor').addEventListener('change', () => { if (!dictionaryPane.hidden)
    refreshDictionary(); });
