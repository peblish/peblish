# G0 groundwork status

Lane G0 of peblish Phase 1, branch `mvp-w0`. Final state; contracts freeze here.

## Done

- M1 root scaffold: pnpm workspace, Node 24, licences, DCO (770ee82)
- M2 schema package and glob registry generator (a3d8b6d)
- M3 core: migration 0001, `tx` plus `emit` with fault-injection tests, outbox worker, authz brand, mutation registry and type-level tests (b98ab29)
- M4 federation skeleton, ui facade, web shell (/, /healthz, /readyz, server-detected locale), bundled worker and migrate processes (976ffe3)
- M5 boundaries (dependency-cruiser, 7 deliberate violations proven to fail), oxlint, Prettier (f1f14b4)
- M6 e2e: hydration marker in en-US and de-DE, negative control, axe on the shell (9889cac)
- M7 Dockerfile, CI, Renovate, lane script, deploy README, vendor hook (302d3d8)
- M8 generator test, README area guide (153bb55); verification from a clean tree: `pnpm check` green (38 tests), no drift, fresh migrate, e2e 8/8 on the build and on the image, image boots to /healthz

## Cut or left for later lanes

- `c/storage` S3 adapter (B2 builds it with media; env names reserved in deploy/README.md)
- Staging deploy on a peblish.com subdomain (described only, per the brief)
- Outbox pruning and a poison-event skip (a failing event stalls only its consumer; visible in outbox_cursors)
- Renovate config not run through renovate-config-validator (JSON parses; rules reviewed by hand)
