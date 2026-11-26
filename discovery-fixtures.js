'use strict';
const alpha = (version, fields) => ({
    source: 'sample-library', version, system: { id: 'reader-stack', name: 'Fictional Reading Desk', owner: 'Library operations' },
    datasets: [
        { id: 'reading-queue', name: 'Fictional Reading Queue', fields },
        { id: 'genre-rollup', name: 'Fictional Genre Rollup', fields: [{ id: 'genre', type: 'text' }, { id: 'volume', type: 'integer' }] },
    ]
});
const v1Fields = [{ id: 'reader_alias', type: 'text' }, { id: 'queued_at', type: 'timestamp' }];
const fixtures = {
    'sample-library:1': alpha(1, v1Fields),
    'sample-library:2': alpha(2, [...v1Fields, { id: 'loan_reference', type: 'text' }]),
    'sample-garden:1': {
        source: 'sample-garden', version: 1, system: { id: 'garden-stack', name: 'Fictional Seed Library', owner: 'Garden operations' },
        datasets: [{ id: 'seed-index', name: 'Fictional Seed Index', fields: [{ id: 'species', type: 'text' }, { id: 'available', type: 'boolean' }] }]
    }
};
function fixtureOptions() { return Object.values(fixtures).map(x => ({ source: x.source, version: x.version, label: x.system.name })); }
function getFixture(source, version) {
    const key = source + ':' + version;
    return Object.hasOwn(fixtures, key) ? structuredClone(fixtures[key]) : null;
}
module.exports = { fixtureOptions, getFixture };
