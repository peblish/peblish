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
