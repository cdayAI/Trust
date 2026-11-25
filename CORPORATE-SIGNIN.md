# Corporate sign-in

The optional corporate mode uses OpenID Connect Authorization Code with S256 PKCE. Demo and isolated test-code sign-in use their existing launchers. Corporate mode only runs with an explicit workspace and identity configuration.

## Local verification

```sh
npm --prefix oidc ci --ignore-scripts --no-audit --no-fund
npm run test:corporate
npm --prefix scripts/browser-tools ci --ignore-scripts --no-audit --no-fund
RUN_BROWSER_SMOKE=1 npm run test:corporate
```

Set `CHROMIUM_PATH` if using a separately installed Chromium binary. The check starts the corporate launcher and a loopback fixture with a generated signing key and reproducible synthetic identity outcomes. The fixture does discovery, authorization, S256 verification, a confidential code exchange and RS256 signing. Tests cover a provisioned analyst, workspace and role denials, unprovisioned and disabled subjects, mismatched state, nonce and PKCE, invalid signature, issuer, audience and expiry, a missing ID token, provider denial, callback replay, and sign-out.

The TLS run verifies the certificate and host with Node, and Chromium trusts only the generated fixture key. It exercises Home, Operator Jobs, manual document quarantine configuration, and the `Secure` and `__Host-` cookie attributes.

```sh
fixture_tls=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=local-oidc-fixture' \
  -addext 'subjectAltName=IP:127.0.0.1,IP:127.0.0.2' \
  -keyout "$fixture_tls/key.pem" -out "$fixture_tls/cert.pem"
NODE_EXTRA_CA_CERTS="$fixture_tls/cert.pem" \
  TRUST_TEST_OIDC_TLS_CERT="$fixture_tls/cert.pem" \
  TRUST_TEST_OIDC_TLS_KEY="$fixture_tls/key.pem" RUN_BROWSER_SMOKE=1 npm run test:corporate
```

## Launcher configuration

Use `npm run start:corporate` with the following settings. Keep configuration, private keys, and workspace state in private directories outside the source tree.

| Setting | Purpose |
| --- | --- |
| `TRUST_OIDC_CONFIG` | Path to the private JSON settings file. |
| `TRUST_OIDC_CLIENT_SECRET` | Injected confidential client secret for `client_secret_basic`. |
| `TRUST_OIDC_TLS_CERT`, `TRUST_OIDC_TLS_KEY` | Paths to the HTTPS certificate chain and private key. |
| `TRUST_SQLITE_FILE` | Optional path to a dedicated corporate fixture SQLite database. Required to enable Operator Jobs. |
| `PORT` | Loopback listener port. It must match the configured origin. Defaults to 4173. |

Example configuration uses fictional names and a dedicated storage root.

```json
{
  "origin": "https://trust.example.invalid:4173",
  "issuer": "https://identity.example.invalid/tenant",
  "clientId": "example-registered-client",
  "root": "/private/mvw-trust-corporate",
  "workspaces": [{ "id": "harbor", "label": "Fictional Harbor" }],
  "accounts": [{
    "id": "sample-intake",
    "subject": "issuer-assigned-opaque-id",
    "initialWorkspace": "harbor",
    "memberships": { "harbor": "analyst" }
  }]
}
```

Register the exact redirect URI `<origin>/auth/oidc/callback` with the provider. The launcher pins the request to the configured host and transport. Discovery, authorization, token and signing-key endpoints must use the issuer’s origin. The issuer must advertise S256 PKCE and RS256 ID-token signing. OpenID Client validates the returned issuer, audience, expiry, state and nonce, and verifies the signature against the issuer’s JWKS. The callback returns to a fixed app path.

The configured issuer and exact subject determine the account. Provision each synthetic account ID, initial workspace and role explicitly. Provider email, group and role claims are ignored. Workspace policy controls both UI and API access. Local app sessions are in memory, are bounded by ID-token expiry, and terminate on application sign-out. The provider session is managed by the IdP. List workspace IDs in the optional `attachmentReviewWorkspaces` setting to enable manual attachment quarantine. Each listed workspace requires explicitly provisioned analyst and reviewer seats. The `loopbackFixture` option permits HTTP only for a numeric loopback app and a distinct numeric loopback issuer in local testing.

## Before company use

Company identity and security owners need to approve the tenant, client registration, exact redirect URI, credential storage and rotation, TLS ingress, MFA policies, and the provisioning and offboarding process. Company owners also need to agree on provider logout and revocation behavior because application sign-out clears only the local session. They should confirm the provider’s endpoint layout, supported client authentication, and signing-key rotation against a company-approved sandbox. The launcher binds only to loopback. A shared ingress would require a separate review covering the trusted host, HTTPS topology, exclusion of callback query strings from access logs, and handling of in-memory sessions if more than one process serves requests. This patch was exercised with synthetic identities and a local fixture.
