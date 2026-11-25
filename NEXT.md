# What remains before enterprise rollout

The release is a functioning local synthetic workbench, not an official service.
Use [Local release](LOCAL-RELEASE.md) to run an isolated copy and
[Browser acceptance](BROWSER-ACCEPTANCE.md) for the actual test coverage.

1. Verify the configurable corporate sign-in with an approved company
   test provider and map identities, roles, groups, and lifecycle rules in
   the receiving environment. The local provider is a synthetic fixture.
2. Extend record- and field-level authorization beyond the tested document
   grants, including every list, deep link, bulk action, and export.
3. Increase approved operator-job coverage, preserve independent decision
   gates, and verify all downstream failure and recovery paths.
4. Rehearse the receiving-environment migration with permitted representative
   data, managed backup/restore and rollback, and verify every interactive
   control across applicable roles, data states and supported devices.
5. Obtain the owner approvals and operational sign-off listed in
   [Enterprise readiness](ENTERPRISE-READINESS.md) before any real rollout.

Tracking and consent management are out of scope. Privacy notices and
requests remain separate capabilities.
