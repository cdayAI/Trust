# Offline verification of a finalized synthetic audit

In **Audit management**, choose **Download offline audit package** on a finalized audit, or use `GET /api/audit-management/plans/:id/package` with the active isolated workspace session. Only workspace analysts and reviewers can export it. The manifest records the audit ID and final content checksum, exporting workspace/account/role, and each stable corrective action, finding, and approved attempt. Other audit packages, draft attempts, and other workspaces are not included. Synthetic demo exports record the demo role and no workspace.

The bundle contains the exact UTF-8 bytes of the existing finalized-audit JSON and any published corrective closure reports for this audit, embedded as Base64 without reformatting. The separate original export links and stored source history are unchanged. The canonical manifest uses lexically sorted object keys, stable entry ordering (audit, then corrective actions by ID), and each file's SHA-256 and byte count. The verifier checks both byte digests and correspondence between approved attempt, audited control, corrective action, and current finalized finding. If new approved closures are added later, a new export can include them; the original audit file and previously approved receipts are unchanged.

From a trusted local checkout, verify without contacting the server:

```sh
node scripts/verify-audit-package.js synthetic-audit-package-EXAMPLE.json
node scripts/verify-audit-package.js synthetic-audit-package-EXAMPLE.json --expected-manifest-sha256 YOUR_PREVIOUSLY_RECORDED_DIGEST
```

Use the optional checksum only if recorded independently of the bundle being checked (for example, in a separate trusted archive). Without that anchor, verification checks internal consistency and catches corruption or edits that do not also rewrite hashes and references. An attacker can replace a package and recompute all of its checksums. Verification does not authenticate the claimed account or role, establish legal compliance, or prove all source records were included if a replacement manifest was created. Any trust or provenance claim requires a separately trusted checksum, or a future authenticated signing and key-management design. No keys, signatures, external services, or outside audit data are used.
