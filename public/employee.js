'use strict';
(() => {
    const form = document.querySelector('#employee-code'), list = document.querySelector('#employee-list'), clear = document.querySelector('#employee-clear'), message = document.querySelector('#employee-message');
    if (!form || !list || !clear || !message)
        throw Error('Employee controls missing.');
    const codeSubmit = form.querySelector('button'), codeField = form.elements.namedItem('code');
    if (!codeSubmit || !(codeField instanceof HTMLInputElement))
        throw Error('Employee code controls missing.');
    let localCode, pending;
    function n(tag, text) {
        const element = document.createElement(tag);
        if (text !== undefined)
            element.textContent = text;
        return element;
    }
    function record(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    function assignment(value) {
        return record(value) && typeof value.assignment === 'string' && typeof value.edition === 'string' &&
            typeof value.version === 'number' && typeof value.title === 'string' && typeof value.text === 'string' && typeof value.hash === 'string' &&
            (value.receipt === null || record(value.receipt) && typeof value.receipt.receipt === 'string');
    }
    function clearPage() {
        pending = undefined;
        localCode = undefined;
        form.reset();
        codeSubmit.disabled = false;
        list.replaceChildren();
        clear.hidden = true;
        message.textContent = '';
    }
    async function send(action, fields) {
        const r = await fetch('/api/employee/' + action, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: localCode, ...fields }) });
        const data = await r.json();
        if (!r.ok)
            throw Object.assign(Error(record(data) && typeof data.error === 'string' ? data.error : 'Request failed.'), { status: r.status });
        if (!record(data) || !Array.isArray(data.assignments) || !data.assignments.every(assignment))
            throw Error('Invalid employee response.');
        return { assignments: data.assignments };
    }
    async function run(action, fields) {
        if (pending)
            return;
        const current = {};
        pending = current;
        const submitters = [codeSubmit, ...list.querySelectorAll('button')];
        for (const submitter of submitters)
            submitter.disabled = true;
        message.textContent = '';
        try {
            const data = await send(action, fields);
            if (pending === current)
                render(data);
        }
        catch (error) {
            if (pending === current) {
                if (record(error) && (error.status === 401 || error.status === 429))
                    clearPage();
                message.textContent = error instanceof Error ? error.message : 'Request failed.';
            }
        }
        finally {
            if (pending === current) {
                pending = undefined;
                for (const submitter of submitters)
                    submitter.disabled = false;
            }
        }
    }
    function render(data) {
        const sections = [];
        for (const row of data.assignments) {
            const section = n('section');
            const text = n('p', row.text);
            text.className = 'policy-copy';
            section.append(n('h2', row.title), n('p', 'Policy version ' + row.version), text);
            if (row.receipt)
                section.append(n('p', 'Acknowledged · receipt ' + row.receipt.receipt));
            else {
                const f = n('form'), label = n('label', 'I acknowledge this exact fictional policy edition.'), check = n('input'), submit = n('button', 'Record acknowledgment');
                check.type = 'checkbox';
                check.required = true;
                label.prepend(check);
                f.append(label, submit);
                section.append(f);
                f.onsubmit = event => {
                    event.preventDefault();
                    if (submit.disabled || !check.checked)
                        return;
                    void run('attest', { assignment: row.assignment, edition: row.edition, hash: row.hash, confirm: true });
                };
            }
            sections.push(section);
        }
        list.replaceChildren(...(sections.length ? sections : [n('p', 'You have no assigned policy editions.')]));
    }
    form.onsubmit = event => {
        event.preventDefault();
        if (codeSubmit.disabled)
            return;
        localCode = codeField.value;
        form.reset();
        list.replaceChildren();
        clear.hidden = false;
        void run('assignments', {});
    };
    clear.onclick = () => { clearPage(); codeField.focus(); };
    window.addEventListener('pagehide', clearPage);
})();
