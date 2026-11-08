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

## Contract freeze amendments (root decisions, 2026-11-08)

1. `s/authz.ts`: `SystemJob` ('registration' | 'import' | 'scheduled'); Principal gains `{ kind: 'system', actorId, job }`; Authority gains `{ kind: 'owner', actorId }` and `{ kind: 'system', actorId, job, ref }`. `systemPrincipal(db, job)` in `c/authz/system.ts` returns the local instance actor, which migrate now creates (kind Application, ap_id at the origin root, named after the host; one per database). A cutover import runs migrate without PUBLIC_ORIGIN and inserts the archived instance actor instead.
2. `defineMutation({ recheck: true })` re-runs the policy inside the transaction and throws `Refused` (`c/tx/refused.ts`) with the exact reason on deny; `createPost` opts in, and the registry test requires it for post.create, comment.create and every mod.* action. New test `c/tx/recheck.test.ts`.
3. Site ban and unban policies (`mod.site_ban`, `mod.site_unban`) are a stub in `c/authz/actions/bans.ts` for MODF; community-scope moderation stays in `c/authz/actions/moderation.ts` for AZ (not created by G0). New common refusal `auth.admin_required`.
4. The worker warns when the oldest write transaction on the cluster is older than 30 s (`oldestWriteTransaction()`); README and deploy notes on short transactions.
5. `follows_pair` is now a named UNIQUE (follower_id, followee_id) constraint (it was a unique index); 0001 regenerated through drizzle-kit, triggers re-appended, no drift.
6. `inbox_dedupe` stores the applied activity's id (the inner one inside an Announce), documented on the table, on `Tx.dedupe` and in `packages/federation/README.md`.

## Cut or left for later lanes

- `c/storage` S3 adapter (B2 builds it with media; env names reserved in deploy/README.md)
- Staging deploy on a peblish.com subdomain (described only, per the brief)
- Outbox pruning and a poison-event skip (a failing event stalls only its consumer; visible in outbox_cursors)
- Renovate config not run through renovate-config-validator (JSON parses; rules reviewed by hand)
