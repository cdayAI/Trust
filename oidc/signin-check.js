'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const clientId = 'sample-trust-client';
const subject = 'fixture-provisioned-subject';
const startPath = '/auth/oidc/start';
const callbackPath = '/auth/oidc/callback';
const denial = '/?signin=denied';
const hash = value => createHash('sha256').update(value).digest('base64url');
const json = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function listen(server, host) {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

async function fixture(t, secret, tls) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const accessToken = randomBytes(24).toString('hex');
  const authorizations = new Map();
  const codes = new Map();
  let sequence = 0;
  let exchanges = 0;
  let tokenResponses = 0;
  let origin;
  let callback;

  const handler = async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        jwks_uri: origin + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [key] });
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('redirect_uri') !== callback ||
          p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' ||
          p.get('scope') !== 'openid' || !p.get('state') || !p.get('code_challenge') || !p.get('nonce')) {
        return send(400, { error: 'invalid_request' });
      }
      const transaction = String(++sequence);
      authorizations.set(transaction, p);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Local fixture IdP</title><h1>Local fixture IdP</h1>' +
        '<a href="/choose/' + transaction + '/valid">Provisioned identity</a> ' +
        '<a href="/choose/' + transaction + '/unknown">Unprovisioned identity</a>');
    }
    const choice = /^\/choose\/(\d+)\/([a-z-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && choice) {
      const [, transaction, scenario] = choice;
      const authorization = authorizations.get(transaction);
      if (!authorization) return send(400, { error: 'invalid_request' });
      authorizations.delete(transaction);
      const redirect = new URL(callback);
      const code = 'fixture-code-' + transaction;
      if (scenario === 'provider-denied') redirect.searchParams.set('error', 'access_denied');
      else {
        codes.set(code, { authorization, scenario });
        redirect.searchParams.set('code', code);
      }
      redirect.searchParams.set('state', scenario === 'state' ? 'mismatched' : authorization.get('state'));
      res.writeHead(303, { Location: redirect.href });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      exchanges++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const record = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const encoded = /^Basic +([A-Za-z0-9+/]+=*)$/i.exec(req.headers.authorization || '')?.[1];
      const credentials = Buffer.from(encoded || '', 'base64').toString().split(':')
        .map(value => new URLSearchParams('value=' + value).get('value'));
      if (!record || form.get('redirect_uri') !== callback || form.get('grant_type') !== 'authorization_code' ||
          credentials.length !== 2 || credentials[0] !== clientId || credentials[1] !== secret) {
        return send(400, { error: 'invalid_grant' });
      }
      const { authorization, scenario } = record;
      const verifier = form.get('code_verifier');
      const expectedChallenge = scenario === 'pkce' ? 'mismatched' : authorization.get('code_challenge');
      if (!verifier || hash(verifier) !== expectedChallenge) return send(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: scenario === 'issuer' ? origin + '/other' : origin,
        aud: scenario === 'audience' ? 'another-client' : clientId,
        sub: { unknown: 'unlisted-subject', disabled: 'disabled-subject' }[scenario] ?? subject,
        exp: scenario === 'expiration' ? now - 3600 : now + 300,
        iat: now,
        nonce: scenario === 'nonce' ? 'mismatched' : authorization.get('nonce'),
        roles: ['reviewer', 'identity-admin'],
        groups: ['administrators'],
        email: 'synthetic@example.invalid',
      };
      const jwt = json({ alg: 'RS256', kid: key.kid }) + '.' + json(claims);
      const signature = sign('RSA-SHA256', Buffer.from(jwt), scenario === 'signature' ? wrongKey : privateKey);
      tokenResponses++;
      return send(200, { access_token: accessToken, token_type: 'Bearer',
        ...(scenario === 'missing-id-token' ? {} : { id_token: jwt + '.' + signature.toString('base64url') }) });
    }
    return send(404, { error: 'not_found' });
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  origin = (tls ? 'https://' : 'http://') + '127.0.0.2:' + await listen(server, '127.0.0.2');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    origin, accessToken, get exchanges() { return exchanges; }, get tokenResponses() { return tokenResponses; },
    allowCallback(url) { callback = url; },
  };
}

async function launch(t, provider, secret, tls) {
  const root = await mkdtemp(join(tmpdir(), 'mvw-oidc-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = http.createServer();
  const port = await listen(probe, '127.0.0.1');
  await new Promise(resolve => probe.close(resolve));
  const origin = (tls ? 'https://' : 'http://') + '127.0.0.1:' + port;
  provider.allowCallback(origin + callbackPath);
  const config = join(root, 'fixture-config.json');
  await writeFile(config, JSON.stringify({
    origin, issuer: provider.origin, clientId, loopbackFixture: !tls, root: join(root, 'workspaces'),
    attachmentReviewWorkspaces: ['harbor'],
    workspaces: [{ id: 'harbor', label: 'Fictional Harbor' }, { id: 'orchard', label: 'Fictional Orchard' },
      { id: 'meadow', label: 'Fictional Meadow' }],
    accounts: [
      { id: 'sample-intake', subject, initialWorkspace: 'harbor', memberships: { harbor: 'analyst', meadow: 'analyst' } },
      { id: 'sample-review', subject: 'review-subject', initialWorkspace: 'harbor', memberships: { harbor: 'reviewer' } },
      { id: 'sample-disabled', subject: 'disabled-subject', initialWorkspace: 'orchard',
        memberships: { orchard: 'reviewer' }, disabled: true },
    ],
  }), { mode: 0o600 });

  const child = spawn(process.execPath, ['start-corporate.js'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, NODE_USE_ENV_PROXY: '0', PORT: String(port),
      TRUST_OIDC_CONFIG: config, TRUST_OIDC_CLIENT_SECRET: secret, TRUST_SQLITE_FILE: join(root, 'workbench.sqlite'),
      TRUST_OIDC_TLS_CERT: process.env.TRUST_TEST_OIDC_TLS_CERT || '',
      TRUST_OIDC_TLS_KEY: process.env.TRUST_TEST_OIDC_TLS_KEY || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill('SIGTERM');
    await closed;
    assert.ok(!logs.includes(secret) && !logs.includes(subject) && !logs.includes('fixture-code-') &&
      !logs.includes(provider.accessToken), 'Sign-in material appeared in the application logs.');
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Corporate launcher exited during startup.');
    if ((await fetch(origin + '/health/live').catch(() => null))?.ok) return { origin, root };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Corporate launcher did not become healthy.');
}

const manual = { redirect: 'manual' };
const cookiePair = header => header.split(';', 1)[0];

function directGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'https:' ? https : http;
    transport.get(url, { headers, agent: false }, async response => {
      try {
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, location: response.headers.location, body });
      } catch (error) {
        reject(error);
      }
    }).on('error', reject);
  });
}

test('corporate launcher enforces OIDC and workspace access over real HTTP', { timeout: 45000 }, async t => {
  const secret = randomBytes(24).toString('hex');
  const trustedCert = process.env.TRUST_TEST_OIDC_TLS_CERT;
  const privateKey = process.env.TRUST_TEST_OIDC_TLS_KEY;
  assert.equal(Boolean(trustedCert), Boolean(privateKey), 'Set both fixture TLS file paths.');
  const tls = trustedCert ? { cert: await readFile(trustedCert), key: await readFile(privateKey) } : undefined;
  const cookiePrefix = tls ? '__Host-' : '';
  const flowName = cookiePrefix + 'trust_oidc_flow';
  const provider = await fixture(t, secret, tls);
  const { origin, root } = await launch(t, provider, secret, tls);
  function assertCookie(header, name) {
    assert.ok(header.startsWith(name + '='));
    assert.ok(header.includes('; Path=/;'), 'Cookie needs a root path.');
    assert.ok(header.includes('HttpOnly; SameSite=Lax'), 'Cookie needs HttpOnly and SameSite=Lax.');
    assert.equal(header.endsWith('; Secure'), Boolean(tls));
    assert.ok(!/; Domain=/i.test(header), 'Cookie must remain host-only.');
  }
  const get = (path, cookie) => fetch(origin + path, { ...manual, headers: cookie ? { Cookie: cookie } : {} });
  const post = (path, body, cookie) => fetch(origin + path, {
    ...manual, method: 'POST', body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  });
  async function begin(scenario) {
    const start = await post(startPath, {});
    assert.equal(start.status, 303);
    assertCookie(start.headers.get('set-cookie'), flowName);
    const authorize = new URL(start.headers.get('location'));
    assert.equal(authorize.origin, provider.origin);
    assert.equal(authorize.searchParams.get('redirect_uri'), origin + callbackPath);
    const page = await directGet(authorize);
    assert.equal(page.status, 200);
    const path = /href="(\/choose\/\d+)\/valid"/.exec(page.body)[1];
    const choice = await directGet(provider.origin + path + '/' + scenario);
    const callback = new URL(choice.location);
    assert.equal(callback.origin, origin);
    assert.equal(callback.pathname, callbackPath);
    return { callback: callback.pathname + callback.search, flow: cookiePair(start.headers.get('set-cookie')) };
  }

  await t.test('the configured origin, callback and session mode are pinned', async () => {
    assert.deepEqual(await (await get('/api/session')).json(), { mode: 'corporate-oidc', authenticated: false });
    assert.equal((await get('/api/state?workspace=harbor')).status, 401);
    assert.equal((await get(startPath)).status, 405);
    assert.equal((await fetch(origin + startPath, { method: 'POST', headers: { Origin: provider.origin } })).status, 403);
    assert.equal((await post(startPath + '?returnTo=https://example.invalid', {})).status, 403);
    assert.equal((await post('/api/session/login', { account: 'sample-intake', workspace: 'harbor' })).status, 404);
    const forged = await directGet(origin + '/api/session', { Host: '127.0.0.1:1' });
    assert.equal(forged.status, 403);
  });

  await t.test('valid code grants only the provisioned role on Home, documents and Operator Jobs', async () => {
    const { callback, flow } = await begin('valid');
    const unbound = await get(callback, flowName + '=' + randomBytes(32).toString('base64url'));
    assert.equal(unbound.headers.get('location'), denial);
    const result = await get(callback + '&returnTo=https://example.invalid', flow);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    const cookies = result.headers.getSetCookie();
    assert.match(cookies[0], /Max-Age=0/);
    assertCookie(cookies[1], cookiePrefix + 'trust_corporate_session');
    const session = cookiePair(cookies[1]);
    const info = await (await get('/api/session', session)).json();
    assert.equal(info.account, 'sample-intake');
    assert.equal(info.actor, 'analyst');
    assert.equal(info.workspace, 'harbor');
    assert.equal(info.capabilities.workspaceAudit, false);
    assert.deepEqual(info.workspaces.map(workspace => workspace.id), ['harbor', 'meadow']);
    assert.equal((await get('/api/state?workspace=harbor', session)).status, 200);
    assert.equal((await get('/api/workspace-home?workspace=harbor', session)).status, 200);
    assert.equal((await get('/api/operator/v1/jobs?workspace=harbor', session)).status, 200);
    const decision = '/api/operator/v1/jobs/00000000-0000-0000-0000-000000000000/decision?workspace=harbor';
    assert.equal((await post(decision, {}, session)).status, 403);
    const documents = await get('/api/governance-documents?workspace=harbor', session);
    assert.equal(documents.status, 200);
    assert.equal((await documents.json()).attachmentRules.manualReview, true);
    assert.equal((await get('/api/state?workspace=orchard', session)).status, 403);
    assert.equal((await get('/api/audit/export?workspace=harbor', session)).status, 403);
    assert.equal((await get('/api/identity-admin?workspace=harbor', session)).status, 403);
    assert.equal((await post('/api/session/switch', { current: 'harbor', workspace: 'orchard' }, session)).status, 403);
    const replay = await get(callback, flow);
    assert.equal(replay.headers.get('location'), denial);
    assert.equal(replay.headers.getSetCookie().length, 1);
    const switched = await post('/api/session/switch', { current: 'harbor', workspace: 'meadow' }, session);
    assert.equal(switched.status, 200);
    const newSession = cookiePair(switched.headers.get('set-cookie'));
    assert.equal((await get('/api/state?workspace=harbor', session)).status, 401);
    assert.equal((await get('/api/state?workspace=meadow', newSession)).status, 200);
    assert.equal((await post('/api/session/logout', {}, newSession)).status, 200);
    assert.equal((await get('/api/state?workspace=meadow', newSession)).status, 401);
  });

  for (const scenario of ['unknown', 'disabled', 'state', 'nonce', 'pkce', 'signature',
    'issuer', 'audience', 'expiration', 'missing-id-token', 'provider-denied']) {
    await t.test('denies ' + scenario + ' without issuing a session', async () => {
      const { callback, flow } = await begin(scenario);
      const before = provider.exchanges;
      const beforeTokens = provider.tokenResponses;
      const result = await get(callback, flow);
      assert.equal(result.status, 303);
      assert.equal(result.headers.get('location'), denial);
      assert.equal(result.headers.getSetCookie().length, 1);
      assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
      if (['state', 'provider-denied'].includes(scenario)) assert.equal(provider.exchanges, before);
      else assert.equal(provider.exchanges, before + 1);
      const tokenReturned = !['state', 'provider-denied', 'pkce'].includes(scenario);
      assert.equal(provider.tokenResponses, beforeTokens + Number(tokenReturned));
    });
  }

  await t.test('Chromium crosses the IdP boundary and renders allowed and denied outcomes',
    { skip: process.env.RUN_BROWSER_SMOKE !== '1' }, async () => {
      const paths = [join(__dirname, '../scripts/browser-tools')];
      const { chromium } = require(require.resolve('playwright', { paths }));
      let executablePath = process.env.CHROMIUM_PATH;
      if (!executablePath) {
        const previousTmpdir = process.env.TMPDIR;
        try {
          process.env.TMPDIR = root;
          const { default: bundled } = require(require.resolve('@sparticuz/chromium', { paths }));
          executablePath = await bundled.executablePath();
        } finally {
          if (previousTmpdir === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = previousTmpdir;
        }
      }
      const args = ['--no-sandbox', '--no-proxy-server'];
      if (tls) {
        const key = new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' });
        args.push('--ignore-certificate-errors-spki-list=' + createHash('sha256').update(key).digest('base64'));
      }
      const browser = await chromium.launch({ executablePath, args });
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        await page.getByRole('heading', { name: 'Sign in with your organization' }).waitFor();
        assert.equal(await page.locator('#local-login').isVisible(), false);
        const [startResponse] = await Promise.all([
          page.waitForResponse(response => response.url() === origin + startPath),
          page.getByRole('button', { name: 'Continue with organization sign-in' }).click(),
        ]);
        assert.equal(startResponse.status(), 303);
        await page.waitForURL(provider.origin + '/authorize?*');
        await page.getByRole('link', { name: 'Provisioned identity', exact: true }).click();
        await page.locator('#workbench').waitFor();
        assert.equal(await page.locator('#local-account').textContent(), 'sample-intake · analyst');
        assert.equal(await page.locator('#audit-export').isVisible(), false);
        await page.locator('#home-view').getByRole('heading', { name: 'My next actions' }).waitFor();
        await page.locator('#show-operator-jobs').click();
        const jobs = page.locator('#operator-jobs-view');
        await jobs.getByRole('heading', { name: 'Queue operator job' }).waitFor();
        assert.equal(await jobs.getByRole('combobox', { name: 'Action' }).locator('option[value="audit.plan.begin"]').count(), 1);
        if (tls) {
          const sessionCookies = await page.context().cookies(origin);
          assert.ok(sessionCookies.some(cookie =>
            cookie.name === '__Host-trust_corporate_session' && cookie.secure && cookie.httpOnly));
        }
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await page.getByRole('button', { name: 'Continue with organization sign-in' }).click();
        await page.getByRole('link', { name: 'Unprovisioned identity', exact: true }).click();
        await page.getByText('Sign-in failed or this account does not have workspace access.').waitFor();
        assert.equal(await page.locator('#workbench').isVisible(), false);
        assert.equal(await page.locator('#demo-identity').isVisible(), false);
        assert.equal(new URL(page.url()).origin, origin);
      } finally {
        await browser.close();
      }
    });
});
