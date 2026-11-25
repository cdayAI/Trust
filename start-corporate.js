'use strict';

const { readFileSync } = require('node:fs');
const { createServer } = require('./server');
const { launchLocalServer } = require('./operational-health');
const { parseJsonBytes } = require('./durable-storage');

launchLocalServer(() => {
  const config = parseJsonBytes(readFileSync(process.env.TRUST_OIDC_CONFIG));
  const { origin, issuer, clientId, loopbackFixture, root, workspaces, accounts, attachmentReviewWorkspaces } = config;
  const { protocol, port } = new URL(origin);
  if (Number(process.env.PORT ?? 4173) !== Number(port || (protocol === 'https:' ? 443 : 80))) {
    throw new Error('PORT must match the configured application origin.');
  }
  const tls = protocol === 'https:' ? {
    cert: readFileSync(process.env.TRUST_OIDC_TLS_CERT),
    key: readFileSync(process.env.TRUST_OIDC_TLS_KEY),
  } : undefined;
  const server = createServer({
    isolated: { root, workspaces, accounts, attachmentReviewWorkspaces },
    sqliteFile: process.env.TRUST_SQLITE_FILE,
    corporate: { origin, issuer, clientId, clientSecret: process.env.TRUST_OIDC_CLIENT_SECRET, loopbackFixture },
    tls,
    operationalEvents: true,
  });
  return { server, onListening: () => console.log('MVW Trust corporate sign-in: ' + origin) };
});
