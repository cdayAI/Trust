'use strict';

const { randomBytes } = require('node:crypto');
const oidc = require('openid-client');

const startPath = '/auth/oidc/start';
const callbackPath = '/auth/oidc/callback';
const deniedPath = '/?signin=denied';
const flowSeconds = 300;
const flowLimit = 256;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const invalid = () => new Error('Invalid corporate sign-in configuration.');
const isLoopback = url => /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]';

function parseUrl(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.username || url.password || url.href.includes('#')) throw invalid();
  return url;
}

function createOidc({ issuer, origin, clientId, clientSecret, loopbackFixture = false }) {
  const issuerUrl = parseUrl(issuer);
  const app = parseUrl(origin);
  if (app.origin !== origin || issuerUrl.href.includes('?') || issuerUrl.hostname === app.hostname ||
      typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim() ||
      typeof loopbackFixture !== 'boolean') throw invalid();
  if (loopbackFixture) {
    if (app.hostname !== '127.0.0.1' || !isLoopback(issuerUrl) ||
        app.protocol !== 'http:' || issuerUrl.protocol !== 'http:') throw invalid();
  } else if (app.protocol !== 'https:' || issuerUrl.protocol !== 'https:') {
    throw invalid();
  }

  const callback = new URL(callbackPath, app);
  const secure = app.protocol === 'https:';
  const cookieName = secure ? '__Host-trust_oidc_flow' : 'trust_oidc_flow';
  const flowCookie = (token = '', age = 0) =>
    `${cookieName}=${token}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const pending = new Map();

  function trustedEndpoint(value) {
    const url = parseUrl(value);
    if (url.origin !== issuerUrl.origin) throw invalid();
  }

  let discovery;
  function configuration() {
    discovery ??= (async () => {
      const config = await oidc.discovery(issuerUrl, clientId, { id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretBasic(clientSecret), {
          execute: loopbackFixture ? [oidc.allowInsecureRequests] : [],
          timeout: 5,
          [oidc.customFetch](url, options) {
            trustedEndpoint(url);
            return fetch(url, { ...options, redirect: 'error' });
          },
        });
      const metadata = config.serverMetadata();
      if (metadata.issuer !== issuer || !metadata.supportsPKCE('S256') ||
          !Array.isArray(metadata.id_token_signing_alg_values_supported) ||
          !metadata.id_token_signing_alg_values_supported.includes('RS256')) throw invalid();
      for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
        trustedEndpoint(endpoint);
      }
      oidc.enableNonRepudiationChecks(config);
      return config;
    })().catch(error => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  }

  return {
    origin, host: app.host, secure,
    async start() {
      const config = await configuration();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const at = Date.now();
      for (const [key, flow] of pending) {
        if (flow.until <= at) pending.delete(key);
      }
      if (pending.size >= flowLimit) throw new Error('Corporate sign-in capacity reached.');
      const binding = randomBytes(32).toString('base64url');
      const location = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback.href,
        scope: 'openid',
        response_type: 'code',
        response_mode: 'query',
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        nonce,
      });
      pending.set(binding, { state, verifier, nonce, until: at + flowSeconds * 1000 });
      return { location: location.href, cookie: flowCookie(binding, flowSeconds) };
    },
    async complete(req, query) {
      const cookies = (req.headers.cookie || '').split(';').map(value => value.trim())
        .filter(value => value.startsWith(cookieName + '='));
      const binding = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : '';
      const flow = tokenPattern.test(binding) ? pending.get(binding) : undefined;
      if (!flow) throw new Error('Missing sign-in transaction.');
      pending.delete(binding);
      if (flow.until <= Date.now()) throw new Error('Expired sign-in transaction.');
      const current = new URL(callback);
      current.search = query;
      const config = await configuration();
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier,
      });
      const { sub, exp } = tokens.claims();
      return { subject: sub, until: exp * 1000 };
    },
    clear: flowCookie,
  };
}

module.exports = { createOidc, startPath, callbackPath, deniedPath };
