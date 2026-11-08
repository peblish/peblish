# G0 groundwork status

Lane G0 of peblish Phase 1, branch `mvp-w0`. Updated at each milestone.

## Done

- M1 root scaffold: pnpm workspace, Node 24, licences, DCO (770ee82)
- M2 schema package and glob registry generator (a3d8b6d)
- M3 core: migration 0001, `tx` plus `emit` with fault-injection tests, outbox worker, authz brand, mutation registry and type-level tests (b98ab29). 22 core tests green on Postgres 17.

## In progress

- M4 federation skeleton, ui facade, web shell, worker entry

## Next

- M5 boundaries (dependency-cruiser) and lint
- M6 e2e (Playwright hydration marker en-US and de-DE, axe)
- M7 Dockerfile, lane script, deploy README, CI, Renovate
- M8 verification run and report
