'use strict';
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const fs = require("node:fs");
const policy = require("./access-policy");
const rust = require('./rust-core');
const { capabilities } = policy;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
const ident = /^[a-z][a-z0-9-]{0,47}$/;
const codePattern = /^[A-Za-z0-9_-]{43}$/;
const roles = new Set(['analyst', 'reviewer', 'case-operator', 'publisher', 'ethics-investigator', 'ethics-reviewer']);
const digest = (value) => (0, node_crypto_1.createHash)('sha256').update(value).digest();
function denied(status, message) { throw Object.assign(new Error(message), { status }); }
function createAccess({ root, workspaces, accounts, sessionSeconds = 1800, enableIdentityAdmin = false, now = Date.now }, readIdentityRecord = () => ({ revision: 0, disabled: false }), workspaceFeatures = () => ({}), oidc = null, documentReviewer = () => false) {
    if (typeof root !== 'string' || !root || !Number.isSafeInteger(sessionSeconds) || sessionSeconds < 1 || sessionSeconds > 3600 ||
        typeof now !== 'function' || typeof readIdentityRecord !== 'function' || typeof enableIdentityAdmin !== 'boolean' || !Array.isArray(workspaces) || !workspaces.length || !Array.isArray(accounts) || !accounts.length)
        throw new Error('Invalid isolated workspace configuration.');
    const mode = oidc ? 'corporate-oidc' : 'local-isolated';
    const cookieName = oidc ? (oidc.secure ? '__Host-trust_corporate_session' : 'trust_corporate_session') : 'trust_local_session';
    const cookie = (token = '', age = 0) => cookieName + '=' + token + '; Path=/; Max-Age=' + age +
        '; HttpOnly; SameSite=' + (oidc ? 'Lax' : 'Strict') + (oidc?.secure ? '; Secure' : '');
    const spaces = new Map(), users = new Map(), seats = new Set(), keys = new Set(), sessions = new Map();
    const subjects = new Map();
    const base = (0, node_path_1.resolve)(root);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const resolvedRoot = fs.realpathSync(base);
    const safeFile = (folder, name) => {
        const file = (0, node_path_1.join)(folder, name);
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.nlink !== 1)
                throw new Error('Workspace store path is not a private regular file.');
        }
        catch (e) {
            if (!hasCode(e, 'ENOENT'))
                throw e;
        }
        return file;
    };
    for (const { id, label } of workspaces) {
        if (typeof id !== 'string' || !ident.test(id) || spaces.has(id) || typeof label !== 'string' || !label.trim() || label.length > 120)
            throw new Error('Invalid isolated workspace.');
        const folder = (0, node_path_1.join)(resolvedRoot, id);
        try {
            fs.mkdirSync(folder, { mode: 0o700 });
        }
        catch (e) {
            if (!hasCode(e, 'EEXIST'))
                throw e;
        }
        if (!fs.lstatSync(folder).isDirectory() || fs.realpathSync(folder) !== folder)
            throw new Error('Invalid workspace store directory.');
        spaces.set(id, { id, label, file: safeFile(folder, 'state.json'), workflowFile: safeFile(folder, 'workflows.json') });
    }
    for (const { id, codeHash, subject, initialWorkspace, memberships, disabled = false, validUntil = null } of accounts) {
        if (typeof id !== 'string' || !ident.test(id) || users.has(id) || typeof disabled !== 'boolean' ||
            (validUntil !== null && (!Number.isSafeInteger(validUntil) || validUntil < 1)) || !memberships ||
            typeof memberships !== 'object' || Array.isArray(memberships) || !Object.keys(memberships).length)
            throw new Error('Invalid local synthetic account.');
        if (oidc) {
            if (!id.startsWith('sample-') || codeHash !== undefined || typeof subject !== 'string' ||
                !/^[\x21-\x7e]{1,255}$/.test(subject) || subjects.has(subject) || typeof initialWorkspace !== 'string' ||
                !Object.hasOwn(memberships, initialWorkspace))
                throw new Error('Invalid corporate synthetic account.');
            subjects.set(subject, id);
        }
        else {
            if (typeof codeHash !== 'string' || !/^([0-9a-f]{64})$/.test(codeHash) || keys.has(codeHash))
                throw new Error('Invalid local synthetic account.');
            keys.add(codeHash);
        }
        const grants = new Map();
        for (const [space, role] of Object.entries(memberships)) {
            if (typeof role !== 'string')
                throw new Error('Invalid or duplicated workspace role assignment.');
            const seat = space + ':' + role;
            const limited = role === 'reviewer' && documentReviewer(space, id);
            if (!spaces.has(space) || (!roles.has(role) && !(enableIdentityAdmin && role === 'identity-admin')) ||
                (limited && oidc) || (!limited && seats.has(seat)))
                throw new Error('Invalid or duplicated workspace role assignment.');
            if (!limited)
                seats.add(seat);
            grants.set(space, role);
        }
        users.set(id, { id, hash: oidc ? null : Buffer.from(codeHash, 'hex'), subject, initialWorkspace, grants, disabled, validUntil });
    }
    const invalidHash = (0, node_crypto_1.randomBytes)(32);
    const live = (account, at) => rust.enabled ? rust.accountLive(account, at) : !!account && !account.disabled && (account.validUntil === null || at < account.validUntil);
    function tokenOf(req) {
        if (rust.enabled)
            return rust.sessionToken(cookieName, req.headers.cookie || '');
        const tokens = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(cookieName + '='));
        return tokens.length === 1 && codePattern.test(tokens[0].slice(cookieName.length + 1)) ? tokens[0].slice(cookieName.length + 1) : null;
    }
    const membership = (workspace, id) => readIdentityRecord(spaces.get(workspace), id);
    function currentGeneration(session) {
        const record = membership(session.workspace, session.account.id);
        return !record.disabled && record.revision === session.generation;
    }
    function lookup(req) {
        const token = tokenOf(req);
        if (token === null)
            return null;
        const session = sessions.get(token);
        if (!session)
            return null;
        const at = now();
        if (at >= session.until || !live(session.account, at) || !currentGeneration(session)) {
            sessions.delete(token);
            return null;
        }
        return { ...session, token };
    }
    function context(req, expected) {
        const current = lookup(req);
        if (!current)
            denied(401, oidc ? 'Sign in with your organization.' : 'Sign in to a local workspace.');
        if (expected.length !== 1 || expected[0] !== current.workspace)
            denied(403, 'This request does not match the active workspace.');
        return { space: spaces.get(current.workspace), actor: current.account.grants.get(current.workspace),
            account: current.account.id, generation: current.generation,
            ...(documentReviewer(current.workspace, current.account.id) ? { documentReviewer: true } : {}) };
    }
    const describe = (session) => ({ mode, authenticated: !!session, ...(session ? {
            account: session.account.id, actor: session.account.grants.get(session.workspace), workspace: session.workspace,
            capabilities: documentReviewer(session.workspace, session.account.id) ? { views: ['governance-docs'], workspaceAudit: false } :
                capabilities(session.account.grants.get(session.workspace), workspaceFeatures(session.workspace)),
            workspaces: [...session.account.grants].filter(([id]) => !membership(id, session.account.id).disabled).map(([id]) => ({ id, label: spaces.get(id).label }))
        } : {}) });
    function issue(account, workspace, previous, authenticationUntil = Infinity) {
        const at = now();
        const until = Math.min(at + 1000 * sessionSeconds, account.validUntil ?? Infinity, authenticationUntil);
        if (!live(account, at) || until <= at)
            denied(401, 'Invalid local sign-in.');
        const record = membership(workspace, account.id);
        if (record.disabled)
            denied(401, 'Invalid local sign-in.');
        for (const [key, session] of sessions)
            if (session.until <= at || !live(session.account, at) || (session.account === account && !currentGeneration(session)))
                sessions.delete(key);
        const count = [...sessions].filter(([key, s]) => key !== previous && s.account === account).length;
        if (count >= 8)
            denied(429, 'Local account session limit reached.');
        if (sessions.size >= 256 && (previous === null || !sessions.has(previous)))
            denied(503, 'Local session limit reached.');
        const token = (0, node_crypto_1.randomBytes)(32).toString('base64url'), session = { account, workspace, until, authenticationUntil, generation: record.revision };
        if (previous)
            sessions.delete(previous);
        sessions.set(token, session);
        return { value: describe(session), cookie: cookie(token, Math.ceil((until - at) / 1000)) };
    }
    return {
        describe: (req) => describe(lookup(req)),
        login(req, body) {
            if (oidc)
                denied(404, 'Not found.');
            const input = record(body) ? body : {};
            const account = typeof input.account === 'string' ? users.get(input.account) : null;
            const candidate = typeof input.code === 'string' && codePattern.test(input.code) ? digest(input.code) : invalidHash;
            const matches = (0, node_crypto_1.timingSafeEqual)(account?.hash ?? invalidHash, candidate);
            if (!account || !matches || candidate === invalidHash || typeof input.workspace !== 'string' || !account.grants.has(input.workspace) || !live(account, now()))
                denied(401, 'Invalid local sign-in.');
            return issue(account, input.workspace, tokenOf(req));
        },
        loginOidc(req, { subject, until }) {
            const id = typeof subject === 'string' ? subjects.get(subject) : undefined;
            const account = id === undefined ? undefined : users.get(id);
            if (!oidc || !account || account.initialWorkspace === undefined || typeof until !== 'number' || !Number.isSafeInteger(until))
                denied(401, 'Corporate sign-in denied.');
            return issue(account, account.initialWorkspace, tokenOf(req), until);
        },
        switch(req, body) {
            const current = lookup(req);
            if (!current)
                denied(401, oidc ? 'Sign in with your organization.' : 'Sign in to a local workspace.');
            if (!record(body) || body.current !== current.workspace || typeof body.workspace !== 'string' || !current.account.grants.has(body.workspace) || membership(body.workspace, current.account.id).disabled)
                denied(403, 'Workspace not available for this session.');
            return issue(current.account, body.workspace, current.token, current.authenticationUntil);
        },
        logout(req) { const token = tokenOf(req); if (token !== null)
            sessions.delete(token); return { value: describe(null), cookie: cookie() }; },
        identityRoster(id) {
            return [...users.values()].filter(u => u.grants.has(id)).map(u => ({
                id: u.id, role: u.grants.get(id), configuredDisabled: u.disabled, validUntil: u.validUntil,
                provisioning: digest(JSON.stringify([u.hash?.toString('hex') ?? u.subject, u.validUntil])).toString('hex')
            }));
        },
        identityTime: now,
        context, spaceForProvisionedGrant: (id) => spaces.get(id)
    };
}
module.exports = { createAccess, codeHash: (code) => digest(code).toString('hex') };
