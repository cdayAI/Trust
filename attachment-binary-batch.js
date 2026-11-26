'use strict';
const rust = require('./rust-core');
const contentType = 'application/vnd.mvw-trust.attachment-batch';
const maxManifestBytes = 4096;
const maxFiles = 4;
const maxBytes = 4 * 1024 * 1024;
const requestLimit = 4 + maxManifestBytes + maxBytes;
const pathPattern = /^\/api\/governance-documents\/records\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/revisions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/attachments\/binary-batch$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fileSpec(value) {
    return exact(value, ['filename', 'mediaType', 'size']) && typeof value.filename === 'string' && typeof value.mediaType === 'string' &&
        typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= maxBytes;
}
function fail(status, code, message) { throw Object.assign(Error(message), { status, code }); }
function invalid() { return fail(422, 'ATTACHMENT_BATCH_FRAME', 'The binary batch manifest or file lengths are invalid. Nothing was uploaded.'); }
function decode(bytes) {
    if (!Buffer.isBuffer(bytes))
        invalid();
    let size;
    if (rust.enabled) {
        size = rust.batchHeader(bytes);
        if (size === -2)
            fail(413, 'ATTACHMENT_BATCH_TOO_LARGE', 'The batch cannot exceed 4 MiB total plus framing.');
        if (size < 1)
            invalid();
    }
    else {
        if (bytes.length < 5)
            invalid();
        if (bytes.length > requestLimit)
            fail(413, 'ATTACHMENT_BATCH_TOO_LARGE', 'The batch cannot exceed 4 MiB total plus framing.');
        size = bytes.readUInt32BE(0);
        if (!size || size > maxManifestBytes || 4 + size > bytes.length)
            invalid();
    }
    let manifest;
    try {
        manifest = JSON.parse(decoder.decode(bytes.subarray(4, 4 + size)));
    }
    catch {
        invalid();
    }
    if (!exact(manifest, ['version', 'expectedRevision', 'files']) || manifest.version !== 1 ||
        typeof manifest.expectedRevision !== 'number' || !Number.isSafeInteger(manifest.expectedRevision) || manifest.expectedRevision < 0 ||
        !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > maxFiles)
        invalid();
    if (rust.enabled) {
        const sizes = manifest.files.map((file) => fileSpec(file) ? file.size : 0xffffffff);
        const offsets = rust.batchLayout(bytes.length, size, sizes);
        if (offsets === -2)
            fail(413, 'ATTACHMENT_BATCH_TOO_LARGE', 'The batch cannot exceed 4 MiB total.');
        if (offsets === -1)
            invalid();
        return { expectedRevision: manifest.expectedRevision, files: manifest.files.map((file, i) => {
                if (!fileSpec(file))
                    invalid();
                return { filename: file.filename, mediaType: file.mediaType, data: bytes.subarray(offsets[i], offsets[i] + file.size) };
            }) };
    }
    let offset = 4 + size, total = 0;
    const files = [];
    for (const file of manifest.files) {
        if (!fileSpec(file) || file.size > bytes.length - offset)
            invalid();
        total += file.size;
        if (total > maxBytes)
            fail(413, 'ATTACHMENT_BATCH_TOO_LARGE', 'The batch cannot exceed 4 MiB total.');
        files.push({ filename: file.filename, mediaType: file.mediaType, data: bytes.subarray(offset, offset + file.size) });
        offset += file.size;
    }
    if (offset !== bytes.length)
        invalid();
    return { expectedRevision: manifest.expectedRevision, files };
}
function provision(isolated, sqliteFile, reviewScopes) {
    const ids = isolated?.largePdfAttachmentWorkspaces;
    if (ids === undefined)
        return new Set();
    if (!sqliteFile || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || !reviewScopes.has(id)))
        throw Error('Larger PDF batches require SQLite and manual quarantine in each selected isolated workspace.');
    return new Set(ids);
}
module.exports = { contentType, maxBytes, requestLimit, pathPattern, decode, provision };
