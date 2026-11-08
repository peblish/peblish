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

Packages export source through subpath wildcards (`@peblish/core/tx/tx`), with no barrel files. Areas register outbox consumers, feed predicates, authz policies, inbound handlers, refusals, events and i18n catalogues by adding a file that matches a glob; `pnpm gen` writes the gitignored `*.gen.ts` registries.

## Adding to an area

Each lane adds files in its own area; none of these needs an edit to a shared file.

| To add             | Write                                                                                                                               | Registered by                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| An outbox event    | its ArkType schema with `v: '1'` under its type in `packages/schema/src/events/<area>.ts` (`export const events`)                   | glob; duplicate types fail typecheck            |
| A refusal reason   | `packages/schema/src/refusals/<area>.ts` (`export const refusals`, reason to description)                                           | glob; the union stays closed                    |
| An authz action    | its policy in `packages/core/src/authz/actions/<area>.ts` (`export const policies`), returning `allow(authority)` or `deny(reason)` | glob; the action catalogue is the union of keys |
| A write            | `defineMutation({ action, emits, run })` in `packages/core/src/<area>/`; callers pass the grant from `authorize()`                  | the mutation-registry test checks every export  |
| An outbox consumer | `packages/core/src/<area>/consumer.ts` exporting `consumer = defineConsumer(...)`                                                   | glob                                            |
| A feed predicate   | `packages/core/src/<area>/feed-predicate.ts` exporting `feedPredicate`                                                              | glob                                            |
| An inbound handler | `packages/federation/src/inbound/handlers/<type>.ts` exporting `handler`                                                            | glob                                            |
| A table            | `packages/core/src/<area>/tables.ts`; root generates the migration (`pnpm db:generate`)                                             | drizzle-kit schema glob                         |
| UI strings         | `packages/web/src/i18n/<area>.json`, keyed by language                                                                              | glob                                            |
| A page             | a route under `packages/web/src/routes/` whose content calls `useRouteHydrated()`                                                   | TanStack Router                                 |

Migrations, the lockfile, `packages/*/package.json`, the G0 files under `packages/schema/src/` and `packages/core/src/{db,tx,outbox}/`, `packages/core/src/authz/brand.ts` and the root configuration are root-owned: report a needed change instead of making it.

## Development

Node 24 (`.nvmrc`), pnpm 10 (`packageManager`), Docker for the local services.

```sh
pnpm install
docker compose up -d --wait        # Postgres 17 on 18432, MinIO on 18490/18491, Mailpit on 18425/18426
eval "$(sh scripts/lane.sh g0)"    # this lane's database, port and test database
pnpm check                         # build, typecheck, lint (boundaries, oxlint, prettier), tests
pnpm e2e                           # Playwright against the build, on $PORT
pnpm --filter @peblish/web dev     # dev server on $PORT
```

Contributions are accepted under the [Developer Certificate of Origin](DCO): sign off every commit with `git commit -s`. Server and web app are AGPL-3.0-only, `schema` and `ui` are MIT; see `LICENSE`.
