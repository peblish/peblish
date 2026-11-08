# peblish

peblish is an open-source, ActivityPub-federated, Reddit-style community platform written in TypeScript (Fedify, TanStack Start, Mux UI). Its flagship instance is [feddit.com](https://feddit.com). Phase 1 (the feddit.com cutover MVP) is under way; the plans live in `/Users/admin/.agents/plans/feddit/` on the maintainer's machine (to be published with the first product milestone).

## Layout

| Path                        | Licence       | What                                                                                                                    |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`           | MIT           | ArkType contracts: entities, the RefusalReason union, the versioned outbox event union, view models, site settings keys |
| `packages/core`             | AGPL-3.0-only | Drizzle tables and migrations, `tx` plus `emit`, the outbox worker, authorization, services                             |
| `packages/federation`       | AGPL-3.0-only | Everything ActivityPub; the only package that imports `@fedify/*`                                                       |
| `packages/ui`               | MIT           | The Mux UI facade; the only package that imports `@muxui/react`                                                         |
| `packages/web`              | AGPL-3.0-only | The TanStack Start app and the worker process                                                                           |
| `e2e/`                      | AGPL-3.0-only | Playwright tests against the production build                                                                           |
| `deploy/`                   |               | Image entrypoint and the Easypanel shape                                                                                |
| `spikes/`, `lab/`, `plans/` |               | Phase 0 experiments, the federation lab and the July 2026 plan; outside the workspace                                   |

Packages export source through subpath wildcards (`@peblish/core/tx/tx`), with no barrel files. In `@peblish/ui`, `.tsx` modules are imported without an extension (`@peblish/ui/components/button`) and `.ts` modules with it (`@peblish/ui/tokens/spacing.ts`). `pnpm lint` enforces the package boundaries (`.dependency-cruiser.cjs`, with a failing fixture per rule in `tests/boundaries.test.ts`). `tests/source-guards.ts` covers what that lint cannot see. Product code has no computed `import()`, `require`, `createRequire`, `getBuiltinModule`, `eval`, `Function` or `vm`, and no CommonJS exports. A runtime binding of the grant issuer (`authz/brand.ts`, `authz/authorize.ts`) or of the write pool (`db/write.ts`, `db/pools.ts`) may only be called, never exported, re-exported or passed on. Areas register outbox consumers, feed predicates, authz policies, inbound handlers, refusals, events and i18n catalogues by adding a file that matches a glob; `pnpm gen` writes the gitignored `*.gen.ts` registries.

## Adding to an area

Each lane adds files in its own area; none of these needs an edit to a shared file.

| To add              | Write                                                                                                                                                                                                                                                                                          | Registered by                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| An outbox event     | its ArkType schema with `v: '1'` under its type in `packages/schema/src/events/<area>.ts` (`export const events`)                                                                                                                                                                              | glob; duplicate types fail typecheck            |
| A refusal reason    | `packages/schema/src/refusals/<area>.ts` (`export const refusals`, reason to description)                                                                                                                                                                                                      | glob; the union stays closed                    |
| An authz action     | its policy in `packages/core/src/authz/actions/<area>.ts` (`export const policies`), returning `allow(authority)` or `deny(reason)`                                                                                                                                                            | glob; the action catalogue is the union of keys |
| Moderation policies | community scope (remove, restore, lock, pin, community ban) in `packages/core/src/authz/actions/moderation.ts` (lane AZ); site ban and unban in `packages/core/src/authz/actions/bans.ts` (lane MODF). Both emit `mod.ban`, with `communityId` null for a site ban                             | glob                                            |
| A write             | `defineMutation({ action, emits, recheck, run })` in `packages/core/src/<area>/`; callers pass the grant from `authorize()`, and `run` takes target ids from `grant.subject`                                                                                                                   | the mutation-registry test checks every export  |
| An outbox consumer  | `packages/{core,federation}/src/<area>/consumer.ts` exporting `consumer = defineConsumer({ name, events, startAt, handle })`; wave 1 consumers declare `startAt: 'beginning'`. A handler may `t.emit` a follow-up event or run `mutation.within(t, grant, input)`: both commit with the cursor | glob; a duplicate name stops the worker         |
| A feed predicate    | `packages/core/src/<area>/feed-predicate.ts` exporting `feedPredicate`                                                                                                                                                                                                                         | glob                                            |
| An inbound handler  | `packages/federation/src/inbound/handlers/<type>.ts` exporting `handler`                                                                                                                                                                                                                       | glob                                            |
| A table             | `packages/core/src/<area>/tables.ts`; root generates the migration (`pnpm db:generate`)                                                                                                                                                                                                        | drizzle-kit schema glob                         |
| UI strings          | `packages/web/src/i18n/<area>.json`, keyed by language                                                                                                                                                                                                                                         | glob                                            |
| A page              | a route under `packages/web/src/routes/` whose content calls `useRouteHydrated()`                                                                                                                                                                                                              | TanStack Router                                 |
| Test seeds          | `packages/core/src/testing/seed-<lane>.ts`, one per lane; the existing testing files (`db.ts`, `recreate.ts`, `crash-child.ts`, `crash-consumer.ts`, `fault-mutation.ts`, `seed.ts`) are root-owned                                                                                            | imported by tests                               |

Rules for writes:

- A mutation takes its target ids from `grant.subject`, never from input, and checks its invariants inside the transaction.
- A subject passed to `authorize()` is JSON-like plain data: plain objects, arrays, strings, numbers, booleans, `null`, `undefined` and bigints. `authorize()` copies and deep-freezes the subject and the principal before it awaits anything. A Date (pass an ISO string), Buffer, typed array, Map, Set, class instance, function, symbol, accessor or cycle throws `SnapshotError` (`packages/core/src/authz/frozen.ts`), because freezing cannot make those immutable.
- Set `recheck: true` for every action a moderator, a ban or a lock can revoke: post and comment create and every `mod.*` action. The policy then runs again inside the transaction, and a deny throws `Refused` and writes nothing. `defineMutation` enforces this twice: the type demands it, and definition throws without it (so an internal mutation behind a wrapper cannot skip it). The registry test checks every exported mutation as well.
- With `lock` (set by recheck), a policy reads every row its decision rests on locked, so a revocation that updates an existing row (a soft delete, a demotion, a lock flag) cannot slip in between. Either it committed first and the recheck denies with its reason, or it waits until the write commits. Use `forShare(query, lock)` for rows no write body updates, and `forNoKeyUpdate(query, lock)` (from `packages/core/src/authz/policy.ts`) for any row a write body updates: a counter, a vote tally, a ban target. Reading such a row FOR SHARE and updating it later deadlocks two concurrent writers (40P01), so every policy that reads it uses `forNoKeyUpdate`; mixing the two modes on one row can still deadlock. With `lock`, `authorize()` also re-reads the principal: the actor must exist and not be deleted, and the site role comes from `auth_user`. That read locks the acting actor's row FOR SHARE, so a write body must not update that row.
- A lock on a query that finds no row locks nothing. So a revocation recorded as an INSERT (a ban, a lock row, a removal marker) first takes FOR NO KEY UPDATE, in its own mutation, on the parent row the policies lock: the community actor row, or the target actor row for a site ban. Every policy it revokes locks that same parent row. The seed policies (`posts.ts`, `votes.ts`, `bans.ts`) follow both rules, and each lane's policy helpers do the same.
- Work the instance does as itself (registration, imports, scheduled jobs) authorizes as `systemPrincipal(db, job)`, the local instance actor that migrate creates.
- No network calls inside a write transaction, and keep transactions short. Consumers read only below the oldest open write transaction on the whole Postgres cluster, so on the shared dev cluster a stuck psql transaction in one lane's database stalls every lane's consumers. The worker warns when that horizon lags more than 30 seconds.

Rules for the web server:

- `packages/web/src/server.ts` is the server entry (root-owned). It sends federation requests to `@peblish/federation/http` before any UI route matches, then adds the security baseline from `packages/web/src/server/headers.ts` to every HTML response. Lanes extend that baseline there, not per route.
- Federation answers the ActivityPub endpoints (`/ap/*`, WebFinger, NodeInfo, the inboxes and outboxes) always. It answers `/`, `/u/<name>` and `/c/<name>` only when Accept asks for ActivityPub JSON; otherwise those paths render the UI, with `Vary: Accept`. Imported feddit.com actors keep their ap_ids (contract 6), so `https://feddit.com/u/<name>` and `/c/<name>` are both the ActivityPub id and the human page.
- Lane FED-A owns `packages/federation/src/http.ts`, federation's consumers (`packages/federation/src/<area>/consumer.ts`, run by the worker beside core's) and the bridge `packages/web/src/server/federation.ts`. G0 created them. Web imports nothing else from federation (lint rule `web-federation-entry-points`).

## Ownership

Root owns the lockfile, the drizzle journal and migrations, the root configuration, CI, the `Dockerfile`, `vendor/`, `packages/core/src/{db,tx,outbox}/**`, `packages/core/src/authz/brand.ts` and the shared schema files (`views.ts`, `entities.ts`, `ids.ts`, `registry.ts`, `site-settings.ts` in `packages/schema/src/`). Report a needed change there instead of making it.

A lane edits the schema files its write set names: `authz.ts` and `modlog.ts` for AZ; `identity.ts`, `session.ts` and `invite.ts` for A; and each area's `refusals/<area>.ts` and `events/<area>.ts`. A lane may add dependencies to its own package's `package.json` with exact versions, listing each in `LANE-NOTES.md`. Root regenerates the lockfile and the migrations at integration.

## Development

Node 24 (`.nvmrc`), pnpm 10 (`packageManager`), Docker for the local services.

```sh
pnpm install
docker compose up -d --wait        # Postgres 17 on 18432, MinIO on 18490/18491, Mailpit on 18425/18426
lane_env=$(sh scripts/lane.sh g0) && eval "$lane_env"   # this lane's database, port, test database, S3; stops on failure
pnpm check                         # build, typecheck, lint (boundaries, oxlint, prettier), tests
pnpm e2e                           # Playwright against the build, on $PORT
pnpm dev                           # pnpm gen, then the dev server on $PORT
```

Contributions are accepted under the [Developer Certificate of Origin](DCO): sign off every commit with `git commit -s`. Server and web app are AGPL-3.0-only, `schema` and `ui` are MIT; see `LICENSE`.
