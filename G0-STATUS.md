# G0 groundwork status

Lane G0 of peblish Phase 1, branch `mvp-w0`. Contracts freeze here, with the amendments and review fixes below.

## Done

- M1 root scaffold: pnpm workspace, Node 24, licences, DCO (770ee82)
- M2 schema package and glob registry generator (a3d8b6d)
- M3 core: migration 0001, `tx` plus `emit` with fault-injection tests, outbox worker, authz brand, mutation registry and type-level tests (b98ab29)
- M4 federation skeleton, ui facade, web shell (/, /healthz, /readyz, server-detected locale), bundled worker and migrate processes (976ffe3)
- M5 boundaries (dependency-cruiser, 7 deliberate violations proven to fail), oxlint, Prettier (f1f14b4)
- M6 e2e: hydration marker in en-US and de-DE, negative control, axe on the shell (9889cac)
- M7 Dockerfile, CI, Renovate, lane script, deploy README, vendor hook (302d3d8)
- M8 generator test, README area guide (153bb55); verification from a clean tree: `pnpm check` green (38 tests), no drift, fresh migrate, e2e 8/8 on the build and on the image, image boots to /healthz
- Wave 1 groundwork: `@muxui/react` 0.1.0-rc.6 vendored in `vendor/muxui/` (SHA-256 in its README); `LocaleProvider` mounts `MuxProvider`, and the React Aria hoist and `themes.css` are gone (cac1829)

## Contract freeze amendments (root decisions, 2026-11-08)

1. `s/authz.ts`: `SystemJob` ('registration' | 'import' | 'scheduled'); Principal gains `{ kind: 'system', actorId, job }`; Authority gains `{ kind: 'owner', actorId }` and `{ kind: 'system', actorId, job, ref }`. `systemPrincipal(db, job)` in `c/authz/system.ts` returns the local instance actor, which migrate now creates (kind Application, ap_id at the origin root, named after the host; one per database). A cutover import runs migrate without PUBLIC_ORIGIN and inserts the archived instance actor instead.
2. `defineMutation({ recheck: true })` re-runs the policy inside the transaction and throws `Refused` (`c/tx/refused.ts`) with the exact reason on deny; `createPost` opts in, and the registry test requires it for post.create, comment.create and every mod.* action. New test `c/tx/recheck.test.ts`.
3. Site ban and unban policies (`mod.site_ban`, `mod.site_unban`) are a stub in `c/authz/actions/bans.ts` for MODF; community-scope moderation stays in `c/authz/actions/moderation.ts` for AZ (not created by G0). New common refusal `auth.admin_required`.
4. The worker warns when the oldest write transaction on the cluster is older than 30 s (`oldestWriteTransaction()`); README and deploy notes on short transactions.
5. `follows_pair` is now a named UNIQUE (follower_id, followee_id) constraint (it was a unique index); 0001 regenerated through drizzle-kit, triggers re-appended, no drift.
6. `inbox_dedupe` stores the applied activity's id (the inner one inside an Announce), documented on the table, on `Tx.dedupe` and in `packages/federation/README.md`.

## Review round 1 fixes (2026-11-08)

Items 1-18 (first batch) and 19-48 (second batch). Refinements are folded into the commits of
the items they refine.

| Item       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Commit                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1, 22      | Grants need a module-private issuance token and sit in a WeakSet registry; forgery tests include Reflect.construct, Object.create, a subclass, structuredClone, JSON, a vote.cast grant as post.create and through `as unknown as`                                                                                                                                                                                                                   | 083ae81                   |
| 2          | `authorize()` snapshots and deep-freezes principal, subject and authority before the policy runs; `Frozen<T>` types                                                                                                                                                                                                                                                                                                                                  | 8d1574d                   |
| 3, 38      | `PolicyRequest.lock` and `forShare()` in the seed policies; with lock, the principal is re-read (exists, not deleted, site role from `auth_user`); gated two-connection tests for both interleavings, plus demotion and deletion                                                                                                                                                                                                                     | e545781                   |
| 4, 25      | Boundary lint keeps external edges (doNotFollow), anchors build-output excludes. New rules: `driver-only-in-core-db`, test code never in product, `no-guarded-reexports`, `nothing-imports-tools`. Type-only exemption on core-writer-access; fixtures for every rule but two (resolved imports, Mux CSS, cycle, re-export; the last two came in round 2, item 67); `tests/no-computed-imports.test.ts` (now `tests/source-guards.test.ts`, item 49) | 35f3d00                   |
| 5          | Federation consumer registry (03f7eaa), worker runs core plus federation consumers (278d981), `federation/src/http.ts`, web bridge and `src/server.ts` entry, `web-federation-entry-points` rule                                                                                                                                                                                                                                                     | 03f7eaa, 278d981, 1bc0f2d |
| 6          | Advisory lock on the migration connection through bootstrap; concurrent migrate test on a fresh `_migrate_test` database                                                                                                                                                                                                                                                                                                                             | 41ff0fc                   |
| 7, 11, 24  | Nitro close plugin; pools on globalThis (the web build carries two copies of pools.ts); `databaseReady` never throws; e2e against the built server: hanging database, no and invalid DATABASE_URL, healthy plus SIGTERM exit 0                                                                                                                                                                                                                       | 567219f                   |
| 8, 23      | Locale negotiated against en-US and de-DE with q values, en-US fallback; only that locale reaches `<html lang>`, Intl and the provider; `Vary: Accept-Language`                                                                                                                                                                                                                                                                                      | 55dfe4b                   |
| 9, 12      | `vendor/muxui/` copied before `pnpm fetch`, vendor README corrected; node HEALTHCHECK (web probes /healthz, worker and migrate pass); deploy README overrides                                                                                                                                                                                                                                                                                        | 87054c3                   |
| 10, 44     | `tools/*` private workspace packages in typecheck, a `tools` vitest project and the boundary lint (root tests are now project `repo`); `core/src/fixtures/**` may reach the write pool and test helpers (35f3d00)                                                                                                                                                                                                                                    | 21d3680                   |
| 13         | Duplicate consumer names stop the worker; repo test across both registries; the generator rejects duplicate file keys (03f7eaa) but cannot see names                                                                                                                                                                                                                                                                                                 | 278d981                   |
| 14, 19     | Backoff exponent capped before `power()`; a failing failure-update no longer hides the consumer's error; test from attempts = 60                                                                                                                                                                                                                                                                                                                     | 278d981                   |
| 15         | `recheck: true` required in the types and at definition for post.create, comment.create and mod.*; wrapped-mutation control                                                                                                                                                                                                                                                                                                                          | c7aff06                   |
| 16, 21, 32 | Worker tests: two workers (gated), failure isolation, limit 2 over two transactions of three, type filter, partial-batch rollback, crash child, poll-only delivery, chained event; horizon-dependent counts polled; `oldestWriteTransaction(database)` for the lag test                                                                                                                                                                              | 278d981                   |
| 17         | HTTPS-only origins (HTTP only with `PEBLISH_ALLOW_HTTP_ORIGIN=1` on localhost or .test); canonical origin stored and compared on re-run                                                                                                                                                                                                                                                                                                              | 114818c                   |
| 18, 20     | Required `startAt: 'beginning' \| 'now'` on `defineConsumer`; tests for both, including an old open transaction; README says wave 1 declares 'beginning'                                                                                                                                                                                                                                                                                             | 278d981                   |
| 26         | Generated bindings prefixed `r_`, quoted area keys, duplicate keys throw, `_` helpers and tests skipped; delete.ts, policies.ts, a-b/a_b and _helper cases                                                                                                                                                                                                                                                                                           | 03f7eaa                   |
| 27         | `packages/schema/src/registry.test-d.ts`                                                                                                                                                                                                                                                                                                                                                                                                             | 2b51020                   |
| 28         | ui exports `./*.ts` (imported with the extension) beside `./*.tsx`, proven from web; `react-aria-components` 1.20.0 declared (same copy)                                                                                                                                                                                                                                                                                                             | 22cd3b3                   |
| 29         | DCO check exempts `*[bot]@users.noreply.github.com`; test with a throwaway repository                                                                                                                                                                                                                                                                                                                                                                | 117789d                   |
| 30         | CI image job: postgres service, `scripts/image-smoke.sh` (migrate, worker start and SIGTERM, web /healthz and /readyz, non-root); `persist-credentials: false`; no cancelling on main                                                                                                                                                                                                                                                                | 1816932                   |
| 31, 47     | No g0 defaults in the vitest setup or Playwright config; `lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env"`; lane.sh reports a failure; S3 region and credentials exported                                                                                                                                                                                                                                                                  | 6c01ceb                   |
| 33         | README ownership section, area table seed files, policy and web server rules, FED-A ownership, ap_ids as human pages, `pnpm dev` runs gen; posts.ts and votes.ts headers (the modlog example already used `mod.*`, 2662c8e)                                                                                                                                                                                                                          | 429a4d6                   |
| 34         | Nested `tx()` throws and points at `.within`                                                                                                                                                                                                                                                                                                                                                                                                         | 1a87011                   |
| 35, 36, 37 | Cursor advances past every scanned row; a NOTIFY during a batch is remembered; ConsumerTx has `emit` and `mutation.within` accepts it                                                                                                                                                                                                                                                                                                                | 278d981                   |
| 39, 40, 41 | Truncate guards on modlog and deletion_ledger; modlog keeps ap_ids beside nullable FKs (ON DELETE SET NULL); comments indexes; `inbox_raw.body` is bytea                                                                                                                                                                                                                                                                                             | 2662c8e                   |
| 42         | Bootstrap gives the instance actor an RSA-2048 keypair and its inbox, outbox and shared inbox, idempotently                                                                                                                                                                                                                                                                                                                                          | bc9175b                   |
| 43         | Site ban refuses self, the instance actor and other admins with `target.protected`                                                                                                                                                                                                                                                                                                                                                                   | 4b4038d                   |
| 45         | Dev Postgres `max_connections` 300                                                                                                                                                                                                                                                                                                                                                                                                                   | 06b6b39                   |
| 46         | `web/src/server/headers.ts` baseline on HTML responses (report-only CSP), unit and e2e tests, README line                                                                                                                                                                                                                                                                                                                                            | d781395                   |
| 48         | Node and postgres image digests pinned; Renovate `docker:pinDigests`                                                                                                                                                                                                                                                                                                                                                                                 | 21c3e04                   |

Not done, or done differently:

- 38: the site-ban part of the principal refresh needs MODF's ban table. `c/authz/principal.ts` has the seam comment where MODF adds it.
- 13: the generator cannot see consumer names (they are runtime values), so the duplicate check runs at worker start, with a repo test over both registries.
- 3 and 16: "gated" means deterministic promise gates, run in the normal suite.
- 5: the README assigns the web bridge `web/src/server/federation.ts` to FED-A with `federation/src/http.ts`. The server entry `web/src/server.ts` stays root-owned.

Verification, on this tree:

- `pnpm check` is green: 136 tests in 28 files, no boundary violations, Prettier clean.
- `pnpm db:drift`: none. `pnpm e2e`: 16/16 on the build. The gated interleaving, worker and migrate tests passed three runs in a row.
- `docker build` with the pinned digests, and `scripts/image-smoke.sh` against the compose Postgres: migrate, worker SIGTERM exit 0, web /healthz and /readyz, uid 1000. `pnpm e2e` against the image: 16/16, healthcheck healthy.

## Review round 2 fixes (2026-11-08)

Items 49-68 (round 2 of review on 2b05b31). One commit per item or logical group.

| Item           | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Commit  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 49             | Binding-aware source guards (`tests/source-guards.ts`, test renamed `tests/source-guards.test.ts`). They reject node:module, module, node:vm and vm at runtime in any form, plus require, getBuiltinModule (also by string or destructuring), eval, Function, `.constructor()`, computed members of process and globalThis, and CommonJS exports. Bindings of brand.ts, authorize.ts, write.ts and pools.ts may only be called. 47 negative and 12 positive controls, including the createRequire-alias bypass | 8e37479 |
| 50             | `frozenCopy` takes JSON-like plain data only and throws `SnapshotError` (path, found) otherwise, cycles included. `authorize()` snapshots before the lock-mode principal refresh                                                                                                                                                                                                                                                                                                                               | 31401cb |
| 51             | `forNoKeyUpdate(query, lock)` beside `forShare`. posts.ts, votes.ts and bans.ts read the rows their bodies update (or that an INSERT-recorded revocation locks) FOR NO KEY UPDATE. README and `PolicyRequest.lock` state both rules. A deadlock control, and two rechecking writers that do not deadlock                                                                                                                                                                                                       | 73e6439 |
| 52             | modlog: `community_ap_id`; `actor_ap_id` NOT NULL; CHECKs `modlog_community_ap_id` and `modlog_target_ap_id`. The trigger nulls a reference only once its row is gone. `ModAction.communityApId`; `actorApId` is a string. Purge, tamper and CHECK tests                                                                                                                                                                                                                                                       | 9468f4c |
| 53             | `inbox_raw.body` byte round-trip test (invalid UTF-8 with a NUL, trailing whitespace, a Buffer; length, compare, SHA-256)                                                                                                                                                                                                                                                                                                                                                                                      | c906016 |
| 54             | Vary: Accept on both bridge branches; a declined GET renders the page as HTML (Start answered 406). `e2e/server/federation.spec.ts`                                                                                                                                                                                                                                                                                                                                                                            | f9f9bd4 |
| 55             | Locale: the most specific range sets each locale's q, so an explicit q=0 wins; q is case-insensitive                                                                                                                                                                                                                                                                                                                                                                                                           | 1597b6a |
| 56             | Enforcing `content-security-policy: frame-ancestors 'none'` plus `x-frame-options: DENY`; the fuller policy stays report-only                                                                                                                                                                                                                                                                                                                                                                                  | e74eb7d |
| 57             | `PEBLISH_PROCESS` (web, worker, migrate) selects the process. The entrypoint exits 64 when a command disagrees, and the healthcheck goes by role and fails closed. image-smoke.sh runs the healthchecks                                                                                                                                                                                                                                                                                                        | 7ad34aa |
| 58             | README: `processBatch` and `runMigrations` contracts, the exact recheck allowlist, an owner for every G0 file. `activities.inbox_raw_id` links an activity to its exact bytes                                                                                                                                                                                                                                                                                                                                  | 2042810 |
| 59, 60, 62, 64 | `defineConsumer({ emits })`; a consumer emitting a type it consumes is refused at start. Refused in a consumer is permanent: savepoint rollback, error log, `outbox_cursors.refused`, cursor moves on. `onReady` after cursors and LISTEN; the worker logs 'stopped' or 'crashed'. An abort mid-iteration skips the poll timer                                                                                                                                                                                 | 452301e |
| 61, 63         | Bootstrap backfills missing instance actor endpoints; readiness logs a configuration error once                                                                                                                                                                                                                                                                                                                                                                                                                | 5b763f5 |
| 65, 66         | Playwright needs DATABASE_URL only when it starts the server; the lifecycle specs skip under BASE_URL; the message uses the lane_env form                                                                                                                                                                                                                                                                                                                                                                      | 30efa78 |
| 67             | Fixtures for nothing-imports-tools and not-to-unresolvable, and a test that every rule has one                                                                                                                                                                                                                                                                                                                                                                                                                 | 2c22ae7 |
| 68             | `MigrationHistoryError` for a database migrated from other migration files; lane.sh prints the dropdb and re-run command                                                                                                                                                                                                                                                                                                                                                                                       | 4bb5005 |

API and type changes (names for the briefs):

- `forNoKeyUpdate(query, lock)` in `packages/core/src/authz/policy.ts`, beside `forShare(query, lock)`.
- `SnapshotError` (`path`, `found`) in `packages/core/src/authz/frozen.ts`, thrown by `frozenCopy` and so by `authorize()`.
- `ModAction.communityApId: string | null`; `ModAction.actorApId` is now `string`. The columns are `modlog.community_ap_id` and `modlog.actor_ap_id NOT NULL`, with the constraints `modlog_community_ap_id` and `modlog_target_ap_id`.
- `activities.inbox_raw_id` (`inboxRawId`), referencing `inbox_raw`, ON DELETE SET NULL.
- `Consumer.emits` and `defineConsumer({ emits? })` (default none). `assertRunnable(consumers)` replaces `assertUniqueNames`.
- A `Refused` inside a consumer has no constant. The rule is the code path in `processBatch`, plus the column `outbox_cursors.refused` (integer, default 0).
- `WorkerOptions.onReady`.
- `processBatch(consumer, limit = 100): Promise<number>` returns the rows the cursor moved past (scanned, matching or not), not the events handled. 0 means caught up, backing off, or locked by another worker.
- `runMigrations(url, { folder?, after? })` holds `pg_advisory_lock(hashtext('peblish.migrate'))` through the migrations and `after`. It throws `MigrationHistoryError` (exported from `packages/core/src/db/migrate.ts`) before running anything on a divergent history.
- `PEBLISH_PROCESS=web|worker|migrate` is the image's process selector. It is read by `deploy/entrypoint.sh` (exit 64 on disagreement) and `deploy/healthcheck.mjs`. The image has no CMD.
- Security headers: `content-security-policy` and `x-frame-options` join the baseline in `packages/web/src/server/headers.ts`.

Decided differently, or worth a look:

- 54: the reviewer expected the HTML shell from GET / with an ActivityPub Accept, but TanStack Start answered 406 there. The bridge now passes a declined GET or HEAD to the UI as a fresh request for HTML. Other methods go through unchanged.
- 51: votes.ts locks a comment's post row as well, because the policy joins it. Comment votes in one thread therefore take turns on that row; B1 may narrow the lock to the comment.
- 52: `actor_ap_id` is NOT NULL as asked. When only an announcing remote community is known, actorApId names that community and actorId is null.
- 57: the healthcheck can't see variables the entrypoint exports, so `PEBLISH_PROCESS` lives in the container environment. A command argument must agree with it. This changes how worker and migrate are started: `-e PEBLISH_PROCESS=worker`, not a bare `worker` command.
- 56: the report-only policy grew to `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. It reports, without blocking, the inline scripts the shell uses.
- 68: applied migrations newer than every file pass, so a rollback image can still run migrate.

Verification, on this tree:

- `pnpm check` is green: 242 tests in 31 files, no boundary violations, Prettier clean.
- `pnpm db:drift`: none. `pnpm e2e`: 19/19 on the build. The gated interleaving, worker and migrate tests passed three runs in a row.
- `docker build`, then `scripts/image-smoke.sh` against the compose Postgres, passed. It covered the disagreeing command (64), migrate, the worker's healthcheck and SIGTERM exit 0, and web's /healthz, /readyz and healthcheck (pass, and 1 on a closed port), as uid 1000.
- `BASE_URL=<image> pnpm e2e` without DATABASE_URL: 15 passed, 4 lifecycle specs skipped, healthcheck healthy.

## Cut or left for later lanes

- `c/storage` S3 adapter: built in wave 2 (lane B2, `packages/core/src/storage/`; the `S3_*` variables are in deploy/README.md). Uploads stay off (`uploads.enabled`) until image scanning is live
- Staging deploy on a peblish.com subdomain (described only, per the brief)
- Outbox pruning and a poison-event skip (a failing event stalls only its consumer; visible in outbox_cursors)
- Renovate config not run through renovate-config-validator (JSON parses; rules reviewed by hand)

## Wave 1 integrated (2026-11-09)

Branch `mvp-w1`. Five lanes, each cut from 790a03c; their notes are kept outside the repository in `/Users/admin/.agents/plans/feddit/lane-notes/wave-1/<lane>.md`, and `LANE-NOTES.md` is gone from the tree.

| Lane | What it brought                                                                                       | Head    | Merge   |
| ---- | ----------------------------------------------------------------------------------------------------- | ------- | ------- |
| MUX  | `@muxui/react` 0.1.0-rc.6 vendored, `LocaleProvider` on `MuxProvider` (landed before the merges)      | 0c14d92 |         |
| AZ   | target state and roles, the community `mod.*` policies and mutations, the moderator cache, the modlog | a7d4fe2 | 87bffb7 |
| FIT  | the Lemmy and PieFed wire mapping, the round-trip corpus, fixture sets and `tools/fixture-import`     | 1517d2b | 645c9bc |
| MD   | `renderMarkdown`, `sanitizeRemoteHtml`, the web renderer, the equivalence and XSS suites              | c219142 | c2a74c3 |
| A    | better-auth, registration and invites, sessions, TOTP, account deletion, the auth pages and e2e       | 464472e | addb104 |

Integration commits, after the merges:

| Commit  | Change                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6bd93be | Lockfile regenerated once (node_modules deleted first); `pnpm install --frozen-lockfile` is up to date                                                                                                                     |
| 45664a7 | Migration `0002_wave_1` (below); `writeModlog` sets `modlog.public` and the read model filters on it; the new entity fields                                                                                                |
| f2f8adf | Site settings `registration.cap` (integer >= 0, default 25) and `modlog.trusted_instances` (string[], default none); registration reads the cap from the contract; `readModlog` defaults `trustedInstances` to the setting |
| d964ce8 | The recheck's principal refresh grants `siteRole: 'admin'` only with two-factor on                                                                                                                                         |
| 14bab52 | The first-admin script ships in the image as `/app/processes/admin.mjs`; `image-smoke.sh` runs it                                                                                                                          |
| 6110bd6 | README (fixture sets row, lock order, the narrowed `forNoKeyUpdate` rule), deploy README (auth and mail variables, the first admin), Renovate's Node description, Mailpit and `SMTP_URL` in CI                             |
| (this)  | This section; `LANE-NOTES.md` removed                                                                                                                                                                                      |

Migration `0002_wave_1`, generated once by drizzle-kit from the tables (lane A's stand-in `0002_age_declarations` from 021115b dropped):

- New tables: `community_bans` (primary key community and actor; reason, expires_at, banned_by; index on actor) and `community_removals` (AZ, `c/moderation/tables.ts`); `age_declarations` (A, `c/identity/tables.ts`); `community_languages` (community actor and language, primary key on both, ON DELETE CASCADE; in `c/db/tables/actors.ts`).
- New columns: `posts.url_content_type`, `posts.alt_text`, `posts.thumbnail_url` (text), `posts.nsfl` (boolean not null default false); `actors.nsfl` (default false), `actors.discoverable` and `actors.indexable` (default true), `actors.posting_warning` (text); `modlog.public` (boolean not null default true).
- Seven foreign keys and one index. No trigger, function or 0001 statement. The modlog's append-only trigger compares `to_jsonb(NEW)` minus the references, so it covers `public`; `spine.test.ts` proves an update of it is refused.

Decisions where the brief left room:

1. Lane A's stand-in migration came in with A's merge and was dropped in the migration commit, so the merge shows what the lane brought. In A's merge the lockfile kept this branch's side; FIT's and MD's merged cleanly. `packages/core/package.json` kept both sides.
2. `community_languages` sits in root's `c/db/tables/actors.ts`, beside the community it belongs to; no lane owns it.
3. `modlog.public` is set from `details.public`, which stays the moderation mutations' input and stays in `details` too; the column is what the read model filters and returns.
4. The site settings contract is typed per key (a mapped type), so `readSetting(key)` returns that key's value type now that values are no longer all booleans.
5. Ban-target protection (`isSiteAdmin` in `c/authz/roles.ts`, `target.protected` in `bans.ts`) still goes by role alone: an admin without two-factor cannot act as admin but is still protected from bans. The admins seeded by `seed-az.ts` and `tx/interleaving.test.ts` now have two-factor on.
6. The first-admin script is a third entry of the process bundle rather than shipped source: the runtime image has no sources or node_modules. It needs `BETTER_AUTH_SECRET` on a real host, because the password hash goes through better-auth.
7. `BETTER_AUTH_URL` left the deploy README's reserved names: auth follows the origin migrate stored.
8. Renovate keeps Node below 25 (the root engines field and `.nvmrc`); only the rule's description changed.
9. The FIT mapping was left unchanged here, on the reading that its records extracted none of the new columns' fields. The review showed that Lemmy and PieFed send them; the review fixes now map every 0002 field in both directions (ebeefa0; see Wave 1 review fixes).
10. CI's Mailpit is pinned by digest like its Postgres; `compose.yaml` already had Mailpit on 18425 and 18426, and CI already migrated the database before e2e.

Safety checks: FIT's secrets test passes (no private key block, key field or email address in the manifest, the wire documents or the fixture sets). In tracked and untracked files outside `node_modules` and build output, `PRIVATE KEY` appears only in tests and the guard's own pattern, `privateKeyPem` only as code identifiers, `"privateKey"` nowhere, and `@feddit.com` only in two docs (`plans/archive/`, `spikes/fedify-threadiverse/RESULT.md`). Nothing was removed.

Verification, on this tree (lane root):

- `pnpm install --frozen-lockfile`: up to date.
- `pnpm check` is green: 936 tests in 55 files passed, 2 files skipped (FIT's opt-in build and archive tests), no boundary violations (298 modules), oxlint and Prettier clean. Nothing else ran on the shared Postgres, and the worker tests passed on the first run.
- FIT's opt-in tests, run with `FIXTURE_CAPTURES_DIR` and `FEDDIT_ARCHIVE_DB_URL` before the archive was dropped: the corpus rebuilds byte for byte, and the archive subset round-trips with nothing unmappable or undocumented.
- `pnpm db:drift`: none. `scripts/lane.sh root` applied 0002 to `peblish_root` (no MigrationHistoryError).
- `pnpm e2e` on lane root (port 18399, Mailpit from `compose.yaml`): 30/30 (G0's 19 and lane A's 11).
- `docker build`, then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate, the first admin created (role admin, email verified, 16+ declaration) and a second refused with `admin.exists`, worker SIGTERM exit 0, web `/healthz`, `/readyz` and the healthcheck, uid 1000. A rerun on the same database passed too.

Still open from the lane notes (not in the integration brief; updated after the review fixes):

- FIT: `reports.category` is NOT NULL but a Flag has no category (REP needs a default); `published_at` is NOT NULL while peers may omit `published`; no Mbin, Mastodon or live-peer wire yet; later briefs should point at `packages/federation/src/test/fixtures/`, not the gitignored captures.
- A: deny `post.create` and `comment.create` until the email is verified (B1 and D, with the refusal `auth.email_unverified` that 73c6dba added); prune old `throttles` rows (a later lane's job); optionally move `getSessionView` to `packages/web/src/server/session.ts`. Sign-in, password checks, reset mail and invite codes at sign-up are throttled since 8c4a72f.
- MUX: optionally assert in `tests/boundaries.test.ts` that the resolved fixtures resolve.

Housekeeping: `peblish_fit_archive` (8.7 GB) dropped; the lane databases and worktrees stay.

## Wave 1 review fixes (2026-11-09)

Branch `mvp-w1`. The review of 71ebf9f went to four fix lanes, each cut from 71ebf9f with a disjoint write set. Each lane's notes gained a "Review fixes (2026-11-09)" section in `/Users/admin/.agents/plans/feddit/lane-notes/wave-1/<lane>.md`. The merges had no conflicts, and neither the lockfile nor this file changed on any branch.

| Lane | Branch           | Commits | Head    | Merge   |
| ---- | ---------------- | ------- | ------- | ------- |
| AZ   | `mvp-w1-fix-az`  | 7       | e82c41b | 68d7a6b |
| FIT  | `mvp-w1-fix-fit` | 8       | 1062c58 | 72262b8 |
| MD   | `mvp-w1-fix-md`  | 13      | f93eb13 | 6a3e967 |
| A    | `mvp-w1-fix-a`   | 13      | 73c6dba | f483de7 |

Integration commits, after the merges:

| Commit  | Change                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4d5d5e3 | Migration `0003_wave_1_fixes` (below)                                                                                                                                                                                    |
| 07b6d82 | README lock order and the principal refresh comment (`c/authz/principal.ts`) name the self-deletion and self-announcing community exceptions; deploy README: `PEBLISH_TRUSTED_PROXY=traefik` on Easypanel, the SMTP line |
| (this)  | This section; decision 9 and the open items above corrected                                                                                                                                                              |

Migration `0003_wave_1_fixes`, generated once by drizzle-kit from lane A's tables in `c/identity/tables.ts`:

- `throttles`: scope text, key text, window_start timestamptz, count integer, all NOT NULL; primary key `throttles_scope_key_pk` on scope and key.
- `totp_steps`: user_id uuid primary key, step bigint NOT NULL; `totp_steps_user_id_auth_user_id_fk` references `auth_user` ON DELETE CASCADE.
- Nothing else: the 0003 snapshot differs from 0002's only by those two tables. Lane databases built before it (`peblish_a` carries a scratch 0003) fail with `MigrationHistoryError`, and `lane.sh` prints the drop-and-recreate command. `peblish_root` had 0002 only and took 0003 cleanly.

AZ (e82c41b):

| Item | Fix                                                                                                                                                                                                | Commit  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1    | A remote community acting as itself locks its own row FOR NO KEY UPDATE from the start of the principal refresh                                                                                    | 9375d18 |
| 2    | `writeModlog` records `details.announcedBy`; `readModlog` shows a relayed reason only when the actor's and the announcing community's instances are both trusted; a missing community fails closed | de9b67d |
| 3    | Tests: remote moderator freshness in the role table                                                                                                                                                | ccf490a |
| 4    | A vote on a comment checks the post first                                                                                                                                                          | 1a2be18 |
| 5    | Tests: an Announce that names a local community row                                                                                                                                                | d15e2c6 |
| 6    | Tests: the targets of a community ban and unban, as a table                                                                                                                                        | 771ea14 |
| 7    | Why lock, unlock, pin and unpin refuse a removed or deleted post                                                                                                                                   | e82c41b |

FIT (1062c58):

| Item   | Fix                                                                                                                                                                                                                                                       | Commit           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1      | The migration 0002 fields go through both directions; corpus and lab-live rebuilt; a Group stays an ActorRecord with Group-only fields; an Image without mediaType gets `url_content_type` `image/*`; missing search consent reads true; nsfl always sent | ebeefa0, 901fef6 |
| 2      | The archive command exits 1 on an unmappable or undocumented document                                                                                                                                                                                     | 16003c9          |
| 3      | Manifest fixture paths restricted and kept inside the wire corpus                                                                                                                                                                                         | a41dd1e          |
| 4      | Embedded activities bounded: `MappingError` past level 3                                                                                                                                                                                                  | 9e9cdf9          |
| 5      | https-only IRIs, http(s) icons and banners, a bad post link maps to null; `PEBLISH_ALLOW_HTTP_ORIGIN=1` for http in development                                                                                                                           | ca889c3          |
| 6      | `publicKey.ownerApId` kept; the mapping README's "What the caller checks"                                                                                                                                                                                 | 071f232          |
| README | Wording                                                                                                                                                                                                                                                   | 1062c58          |

A (73c6dba):

| Item   | Fix                                                                                                                                                                                                           | Commit  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1      | A TOTP code is refused on replay, through `totp_steps`                                                                                                                                                        | 9abfd6c |
| 2      | `safeRedirect(target, origin)`                                                                                                                                                                                | b6d1e0a |
| 3      | invite.create reads the referrer FOR SHARE                                                                                                                                                                    | 2b8f018 |
| 4      | Reset mail detached through better-auth's background task handler                                                                                                                                             | 03a9606 |
| 5      | Recovery codes revealed once                                                                                                                                                                                  | 37d2039 |
| 6      | A new invite code shown through an encrypted one-time flash; `?created=` gone                                                                                                                                 | 18fd7b3 |
| 7      | `private, no-store` middleware for the auth, invite, settings and admin route groups; bare group paths 404                                                                                                    | 91bb298 |
| 8      | `formSession().reply()` forwards refreshed cookies                                                                                                                                                            | 87435a0 |
| 9      | Negative tests: spent and expired reset links, reused recovery codes, cross-site posts                                                                                                                        | e4827e8 |
| 10     | Postgres limiter (`throttles`) with `PEBLISH_TRUSTED_PROXY`                                                                                                                                                   | 8c4a72f |
| 11, 14 | `account.delete` rechecks after locking the owner's row FOR NO KEY UPDATE: the inner mutation is rechecked, the outer one registered without recheck; the delete policy's LEFT JOIN lock split into two reads | 44c9730 |
| 12     | Invite codes hashed with HMAC under a key derived from `BETTER_AUTH_SECRET`                                                                                                                                   | 5f7f625 |
| 13     | The `auth.email_unverified` refusal (no policy uses it yet)                                                                                                                                                   | 73c6dba |

MD (f93eb13):

| Item  | Fix                                                                                                                                                                   | Commit  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1     | Linear text-align match; values over 200 characters skipped                                                                                                           | d9fad5a |
| 2     | Spoiler marker lines parsed by hand                                                                                                                                   | 01df33b |
| 3     | Image sizing split at the first `::`                                                                                                                                  | 618bd61 |
| 4     | Mentions deduped through a Map, capped at `mentionMaxCount = 50` distinct (`packages/schema/src/markdown.ts`)                                                         | 230e17b |
| 5     | The depth cap counts the tbody and tr a browser inserts; an image at the cap shows only its alt text                                                                  | 0d0b166 |
| 6     | Highlighting capped at 2,000 characters per block and 8,000 per render; the limits are exported from `highlight.ts`                                                   | b573f94 |
| 7     | Implied end tags at the innermost written element; 12 malformed-wrapper vectors with a browser round-trip check; the README no longer claims browser tree equivalence | e86ca3d |
| 8     | Spoiler markers inside fenced code ignored; fences recognised within three columns of the spoiler's indent                                                            | 1bfe1fb |
| 9     | `tg-spoiler` and `span.spoiler` kept out of the excerpt                                                                                                               | 5d92213 |
| 10    | `//` and any backslash refused before URL resolution                                                                                                                  | d52f590 |
| 11    | NUL stripped from the whole input first                                                                                                                               | e24c3fa |
| extra | Footnotes appended in linear time (`footnotes.ts`)                                                                                                                    | a956ee4 |
| 12    | A 400 ms ceiling, plus scaling-ratio checks with bound 20, for the sanitiser and the renderer                                                                         | f93eb13 |

MD's timings, before and after: text-align 4,544 ms to 0.6 ms, a padded spoiler 1,090 ms to 0.7 ms, nested spoilers 7,949 ms to 0.5 ms, alt text 947 ms to 1.0 ms, 4,000 mentions 729 ms to 2.8 ms, two java blocks 4,479 ms to 0.3 ms.

For later lanes:

- FED-B builds the self-announced principal as `{ kind: 'remote', actorId: <community>, announcedBy: { communityId: <same>, announceApId } }`. It treats `target.removed` and `target.deleted` on Undo(Lock) and on unpin as no-ops, or restores first. A relayed modlog reason shows only when both instances are trusted. The origin checks in the mapping README's "What the caller checks" are FED-B's.
- B1, D and FED: mentions, and so ActivityPub tags, stop at 50 distinct.
- B1 and D: `auth.email_unverified` for post.create and comment.create.
- Old `throttles` rows are not pruned yet; a later lane adds the job.

Decisions where the brief left room:

1. The migration is named `0003_wave_1_fixes` (`pnpm db:generate --name wave_1_fixes`, one run), after `0002_wave_1`.
2. The deploy README tells staging and production on Easypanel to set `PEBLISH_TRUSTED_PROXY=traefik`, and adds what that means with Cloudflare proxying in front of Traefik: the address Traefik saw is a Cloudflare edge, so budgets per address apply per edge until the origin takes Cloudflare's traffic alone and the setting moves to `cloudflare`. The SMTP line also covers the verification link sign-up sends, which, like reset mail, fails only into the web log.
3. The principal refresh comment no longer suggests making its read FOR NO KEY UPDATE when a write body must update the acting actor's row; it points at self-deletion's pattern (lock the row first, then the rechecked inner mutation) instead.
4. Besides decision 9 and FIT's open item, the A and MD open items the fixes closed are corrected above: the rate limit landed, and MD's 50 ms bound is gone.
5. The brief counted 14 commits on `mvp-w1-fix-a`; the branch has 13, and every one in its item map is there.

Verification, on this tree (lane root):

- `node_modules` deleted, then `pnpm install --frozen-lockfile`: up to date, no lockfile change.
- `pnpm check` is green: 1,091 tests in 61 files passed, 1 file and 2 tests skipped (FIT's opt-in build test, which needs the captures, and the archive subset, which needs `FEDDIT_ARCHIVE_DB_URL`), no boundary violations (314 modules), oxlint and Prettier clean. Nothing else ran on the shared Postgres.
- FIT's build test with `FIXTURE_CAPTURES_DIR` set to the primary checkout's captures: the corpus and lab-live rebuild byte for byte. The archive subset could not run again, since `peblish_fit_archive` was dropped after wave 1.
- `pnpm db:drift`: none. `scripts/lane.sh root` applied 0003 to `peblish_root` (no MigrationHistoryError).
- `pnpm e2e` on lane root (port 18399, Mailpit from `compose.yaml`): 33/33 (the 30 from wave 1 and lane A's three new specs).
- `docker build -t peblish:w1`, then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (0003 applied; dropped after): the disagreeing command exits 64, migrate, the first admin, worker SIGTERM exit 0, web `/healthz`, `/readyz` and the healthcheck, uid 1000. A rerun on the same database passed too.

Housekeeping: no push; the worktrees, the fix branches, the lane databases (`peblish_a` still carries its scratch 0003) and the `peblish:w1` image tag stay.

## Wave 2 groundwork (2026-11-09)

Branch `mvp-w2`, cut from `mvp-w1` at 8e2ff0c. Groundwork for the wave 2 lanes: the pin recheck, jobs (`defineJob`) beside the outbox consumers, the delivery-queue transaction exemption, `auth.email_unverified` (already in `refusals/identity.ts`), the post and vote events, the post and comment view fields, the inbound 503 seam and `PEBLISH_UI_KIT` in CI.

| Item | Change                                                                                                                                                                                                                                                      | Commit  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1    | Pins rechecked, nothing upgraded (below)                                                                                                                                                                                                                    | (this)  |
| 2    | `defineJob({ name, everyMs, run })` and `runJobs` in `c/outbox/jobs.ts`; `pnpm gen` registers `packages/{core,federation}/src/**/job.ts` into `jobs.gen.ts`; the worker runs both lists beside the consumers; repo test over the names; lint and README row | 078de60 |
| 3    | `core-tx-access` exempts `packages/federation/src/delivery/` (FED-A's delivery queue); an allowed fixture there, and a federation fixture outside `inbound/` and `delivery/` that still fails                                                               | a0ec33c |
| 4    | Nothing added: `auth.email_unverified` is in `packages/schema/src/refusals/identity.ts` (lane A, 73c6dba), and `refusals/common.ts` does not repeat it                                                                                                      |         |
| 5    | `post.updated`, `post.deleted`, `post.restored` with `post.created`'s fields; `vote.cast` gains `apId` and `previousApId` (`string \| null`), still `v: 1`                                                                                                  | 291eac1 |
| 6    | `PostView` gains `excerpt`, `thumbnailUrl`, `urlContentType`, `nsfl`, `authorBadge`; `CommentView` gains `authorBadge`; `AuthorBadge` (`'admin' \| 'moderator' \| null`) exported from `views.ts`                                                           | 95c70a1 |
| 7    | `receiveInbound(request)` in `packages/federation/src/inbound/receive.ts` answers 503 with `Retry-After: 300`                                                                                                                                               | 7041617 |
| 8    | `PEBLISH_UI_KIT: '1'` in the `check` job's env                                                                                                                                                                                                              | fcbf3b3 |
| 9    | This section                                                                                                                                                                                                                                                | (this)  |

The job runner, as written:

```ts
export interface Job {
  readonly name: string;
  readonly everyMs: number;
  run(signal: AbortSignal): Promise<void>;
}
export function defineJob(spec: { name: string; everyMs: number; run(signal: AbortSignal): Promise<void> }): Job;
export function assertJobsRunnable(jobs: readonly Job[], consumers?: readonly Consumer[]): void;
export function runJobs(options: {
  signal: AbortSignal;
  jobs: readonly Job[];
  onError?: (job: Job, error: unknown) => void;
}): Promise<void>;
```

Pin recheck (npm registry, 2026-11-09):

- `drizzle-orm` 0.45.4 and `drizzle-kit` 0.31.11 are the `latest` tags and the newest on their lines. Drizzle 1.0 is at `1.0.0-rc.5` (2026-10-21) on the `rc` tag, beside `1.0.0-beta.22`; not taken.
- `nitro` 3.0.261103-rc (2026-11-03) is the `latest` tag and the newest release.
- `@fedify/fedify` 2.4.5 (2026-10-23) is `latest` and the newest stable 2.4.x. A `2.4.6-dev.2628` prerelease (2026-11-05) is on the patch line, and 2.5.0 is still at dev builds (`2.5.0-dev.2664`, 2026-11-07).

Decisions where the brief left room:

1. Item 4: the refusal kept lane A's wording ("The acting account has not verified its email address (auth_user.email_verified) yet."), not the brief's. Keys must be unique across the refusal files, so a second copy in `common.ts` would fail anyway.
2. A job runs once when the worker starts, then `everyMs` after each run ends. `everyMs` must be a whole number from 1 to 2^31 - 1 ms, refused at definition: `setTimeout` fires a longer delay at once. A daily job (86,400,000) fits.
3. A run that throws the abort after SIGTERM is not logged as a failure; any other error is, through `onError` (`job <name> failed`), and the job runs again `everyMs` later.
4. The worker checks consumer names and job names (against each other) before either loop starts, so a clash exits 1 with nothing written. A crash in one loop aborts the other, and both settle before `shutdown()` closes the pools. `runJobs` refuses duplicate job names on its own too. The worker still logs `worker: running outbox consumers` from the consumers' `onReady` (image-smoke.sh waits for it) and nothing extra for jobs.
5. The runner takes no lock: a job claims its own work (a lease, `FOR UPDATE SKIP LOCKED` or an advisory lock), as the brief and the `Job` doc comment say.
6. `pnpm gen` keys a job by its directory, like a consumer (`delivery/job.ts` registers as `delivery`). The two lists are `jobs` (core) and `federationJobs`.
7. The `core-tx-access` exemption is proven by an allowed fixture at `packages/federation/src/delivery/__fixtures__/opens-tx.ts`, inside FED-A's future directory; the boundary test owns it.
8. `vote.cast`'s activity ids are `'string | null'` as the brief states, not `ApId` (`string.url`).
9. The type test in `c/tx/mutation.test-d.ts` now emits a typed `EventOf<'vote.cast'>` value, so its `@ts-expect-error` stays on the emit line and the new fields are checked.
10. Item 8: no config change is needed. Playwright 1.58.2's `lib/plugins/webServerPlugin.js` starts the server with `{ ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...this._options.env }`, so `PEBLISH_UI_KIT` reaches the e2e server from the lane's shell or CI's job env.
11. The README's glob sentence and the web rules name jobs, beside the new "A job" row.

Verification, on this tree (lane root):

- `pnpm install --frozen-lockfile`: up to date, no lockfile change.
- `pnpm check` is green: 1,100 tests in 63 files passed, 1 file and 2 tests skipped (FIT's opt-in build and archive tests), no boundary violations (320 modules), oxlint and Prettier clean.
- `pnpm db:drift`: none. `scripts/lane.sh root` found nothing pending on `peblish_root`.
- `pnpm e2e` on lane root (port 18399): 33/33.
- The built worker (`packages/web/dist/processes/worker.mjs`) on `peblish_root`, with no jobs registered: `worker: running outbox consumers`, then `worker: stopped` and exit 0 on SIGTERM.
- `docker build -t peblish:w2-groundwork`, then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate, the first admin, the worker starts and stops on SIGTERM with exit 0, web `/healthz`, `/readyz` and the healthcheck, uid 1000. A rerun on the same database passed too.

Housekeeping: no push; the `peblish:w2-groundwork` image tag stays.

## Wave 2 integrated (2026-11-09)

Branch `mvp-w2`, five lanes of the first batch, each cut from 485f084; their notes are kept outside the repository in `/Users/admin/.agents/plans/feddit/lane-notes/wave-2/<lane>.md`, and `LANE-NOTES.md` is gone from the tree. D, C1, COMPOSER and FED-B start from this head, REM after FED-B.

| Lane  | What it brought                                                                                                                                                            | Head    | Merge   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| B2    | the public-address predicate and `safeFetch`, the S3 adapter (`aws4fetch`), image cleaning, uploads behind `uploads.enabled`, link previews, the signed remote-media proxy | bf2a5cf | 7913c44 |
| F     | `community.create`, `.update` and `.set_moderator` (policies, mutations, services), `community_rules`, the community read models                                           | 5d05066 | 4efddc2 |
| B1    | post and vote policies and mutations (`postingRestrictedToMods`, `auth.email_unverified` first), `castVote`, the remote post counterparts, the NSFW gate, the post page    | d3ebd62 | a2e36ef |
| UI    | the shell, colour schemes with true black, density, the component facade, `VoteControl`, `PostCard`, `CommentThread`, `ReplyBar`, the `/kit` gallery, the payload budget   | 5ce0add | c7c5ee4 |
| FED-A | draft-cavage signing and verification, remote actors, serving, WebFinger, NodeInfo, the durable delivery queue, the follows service                                        | 5526679 | 033dbaa |

Only `LANE-NOTES.md` conflicted (add/add in every merge, from the second on): each merge kept the first one's file, and the last commit removes it. The lockfile merged without conflict in the UI and FED-A merges.

Integration commits, after the merges:

| Commit  | Change                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9719a8e | Migration `0004_wave_2` (below)                                                                                                                                       |
| 80ebd58 | Federation's seam `actors/safe-fetch.ts` re-exports core's `safeFetch` (below)                                                                                        |
| 16df4f9 | A link preview returns the `og:image` URL instead of storing a thumbnail                                                                                              |
| 3cf2b33 | The proxy answers `Cache-Control: private, max-age=600`                                                                                                               |
| bb3593c | The `'link-preview'` throttle scope: 30 per client address and 20 per account in ten minutes                                                                          |
| 581c7cd | The post page uses `VoteControl` and `Prose`; B1's `PostVote` and `Html` are gone                                                                                     |
| 0afa376 | `createPostAs` casts the author's upvote after `createPost`                                                                                                           |
| 1b89c25 | F's posting-restriction test runs unconditionally (2 passed)                                                                                                          |
| b20b9c3 | `freshModerator` exported from `authz/roles.ts`; the communities and posts read models use it instead of their own copies                                             |
| 4b0d8f1 | `PEBLISH_UI_KIT: '1'` in Playwright's `webServer.env`; the post page in `e2e/payload/routes.ts`; the CI bundle step and the report's header no longer say report-only |
| 2fc1d93 | CI starts MinIO (compose.yaml's image, by digest) and sets the `S3_*` variables, so the adapter tests run there                                                       |
| 9df8e4d | README: ownership rows for B1, B2, F, FED-A and UI, a rule for outbound requests, the root loader's invalidation rule                                                 |
| eae782f | deploy/README.md: the `S3_*` variables, `BETTER_AUTH_SECRET` also keys proxy URLs, the preview budget, the proxy's `private` answer                                   |
| 251cb19 | B1's gate spec scopes its Sign in link to the page body (the shell has one too)                                                                                       |
| e886daf | This section; the S3 line under "Cut or left"; `LANE-NOTES.md` removed                                                                                                |

Migration `0004_wave_2`, generated once by drizzle-kit after all the merges (it equals F's and FED-A's scratch output, joined):

- `community_rules` (F, `c/communities/tables.ts`): primary key community and position, `title`, `body_md`, `body_html`; check `position >= 1`; foreign key to `actors` ON DELETE cascade.
- `deliveries` (FED-A, `c/delivery/tables.ts`): the queue, one row per activity and inbox (unique `activity_ap_id` and `inbox_url`), state check (`pending`, `delivered`, `failed`, `skipped`); foreign keys to `actors` (sender) and `instances`; indexes `deliveries_due` (partial, `next_attempt_at` where `state = 'pending'`), `deliveries_object` and `deliveries_instance`.
- No trigger, no column on an existing table, no change to an earlier migration. B1, B2 and UI add no table. A lane database that applied a lane's own scratch 0004 fails with `MigrationHistoryError`; `scripts/lane.sh` prints the recreate command.

Dependencies accepted: `aws4fetch` 1.0.20 (core, MIT, B2), `@react-aria/optimize-locales-plugin` 2.1.0 (web, dev, Apache-2.0, UI; it pulls `unplugin` 2.3.11, MIT), `drizzle-orm` 0.45.4 in federation (FED-A; core already had it). Nothing else changed in the lockfile. `pnpm install` after the merges left it as it was, and `pnpm install --frozen-lockfile` is up to date.

Architecture note: signing and signature verification (`signing/`), actor and collection serving, WebFinger, NodeInfo and delivery are all peblish's own code (the review fixes replaced Fedify's signer, which covers the pathname only, with a draft-cavage signer of ours); Fedify is a test-only dependency, the independent implementation `signing.test.ts` checks against. `federation.ts` holds only the software identity, `localOrigin()` and `userAgent()`. Contract 7 (Fedify only inside `packages/federation`) still holds. The batch review and the wave 3 live lab decide whether anything returns to Fedify.

The seam switch: `actors/safe-fetch.ts` is now four lines of re-export from `@peblish/core/net/fetch` and `actors/safe-fetch.test.ts` is gone, so the actor, document, NodeInfo and delivery tests run through the real address predicate. Delivery sends `schemes: ['https:']` and `maxRedirects: 0`, and a `BlockedDestinationError` is permanent (`run.ts`). Documents (actors, WebFinger, NodeInfo) refuse a truncated body (`actors/document.ts`); delivery does not, because it reads only the status and a cut error page is enough. The live lab overlays that one file with a client of its own.

Decisions where the briefs left room:

1. A link preview stores the page's `og:image` URL as the post's `thumbnail_url` as it is, not a signed proxy URL. Pages turn it into `/media/proxy/<signature>/<target>` at render time with `createMarkdownRenderer().image()`, so nothing signed sits in the database, a rotated `BETTER_AUTH_SECRET` breaks no stored value, and federation sends the picture's URL as the Page `image` (`mapping/content.ts`). B1's `-load.ts` already signed any off-origin URL that way.
2. With no thumbnail stored, `recordThumbnail` and the preview's bucket path are gone. The `media.thumbnail` policy stays as the gate on making the server fetch a URL a person chose (kill switch, verified email); its name is now a misnomer, and renaming it is optional. The `thumbnail` kind in `media.stored` and the `media.kind` check stay for SAFE.
3. B2's `/media/proxy` is not in `e2e/payload/routes.ts`: it is an image endpoint with no markup, so there is no first-visit payload to budget. The post page is, through a `target` function that seeds a post with `seed-b1.ts e2e`; it is skipped against a remote `BASE_URL` (126.4 kB of the 170 kB script budget, 60.4 of 65 CSS).
4. `createPostAs` casts the author's upvote through `voteAs`, so it is a real second mutation with its own `vote.cast` event (federated as a Like, FED-A note 5). It is best effort: the post exists either way, so a refusal or an error there is not returned to the caller.
5. `VoteControl` keeps the post-specific group name ("Vote on this post"); the arrows' labels come from the `ui` catalogue (`vote.up` and `vote.down` left `posts.json`). The page no longer replaces its numbers with the server's tally after a vote, as the stand-in did: the optimistic score stands until the next load. A refused vote throws, which `VoteControl` reverts.
6. The moderator freshness rule existed three times (roles, communities, posts); roles.ts exports it as `freshModerator` and the other two use it. AZ's role-table test still pins it.
7. F's posting-restriction test lost its `skipIf` on the refusal reason, so it can no longer skip silently.
8. The CI MinIO step uses the digest of the multi-arch index (it holds linux/amd64) and waits for `/minio/health/live`. The bucket is created by the adapter test.
9. FED-A's edit to `e2e/server/federation.spec.ts` (the instance actor answers `/` for ActivityPub requests) is accepted, as are B1's edits to AZ's `seed-az.ts`, `role-table.test.ts` and `authorize.test.ts`.

Safety checks: FIT's secrets test passes inside `pnpm check`. In tracked files, `PRIVATE KEY` appears only in `tools/fixture-import/src/secrets.ts` (the pattern) and an assertion in `e2e/server/federation.spec.ts` that a served actor has none, `privateKeyPem` only as code identifiers (the key store, signing, the per-test key generators), `"privateKey"` nowhere, and `@feddit.com` nowhere outside docs. The hosts in test files are `*.test`, `example.*`, loopback and private-range literals, plus real names used only as strings (JSON-LD contexts, `feddit.com` in URL-builder unit tests); no test makes a request to one.

Verification, on this tree (lane root):

- `rm -rf node_modules`, `pnpm install`, then `pnpm install --frozen-lockfile`: up to date, lockfile unchanged.
- `pnpm check` is green: 100 test files passed and 1 skipped, 1,481 tests passed and 2 skipped (FIT's opt-in build and archive tests), no boundary violations (503 modules), oxlint and Prettier clean. The S3 adapter tests ran against the compose MinIO. Nothing else ran on the shared Postgres.
- `pnpm db:drift`: none. `scripts/lane.sh root` applied 0004 to `peblish_root` (no MigrationHistoryError).
- `PEBLISH_UI_KIT=1 pnpm e2e` on lane root (port 18399, Mailpit and MinIO from `compose.yaml`): 99 passed, 1 skipped (the test that `/kit` answers 404 where the gallery is off, which needs a server without `PEBLISH_UI_KIT`). That is wave 1's 33, B1's 15, B2's 4 (its post-page spec now runs), UI's gallery, shell and payload specs, and FED-A's six federation specs. The payload budget holds on `/`, `/auth/sign-in`, `/post/<id>` and `/kit`.
- `docker build -t peblish:w2 .`, then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate (0004 applied), the first admin, the worker starts and stops on SIGTERM with exit 0, web `/healthz`, `/readyz` and the healthcheck, uid 1000. A rerun on the same database passed too.

Still open from the lane notes (not in the integration brief):

- B2: a lint rule against raw outbound HTTP in product code (`safeFetch` protects only what uses it; `fetch.test.ts` guards `createSafeFetch` only); a sweep of bucket objects with no row (a crash between put and commit); the proxy has no per-address limit and no HEAD; images are cleaned, not re-encoded or resized (decision 1 of B2's notes, accepted); `::/96` is refused whole.
- F: `community.set_moderator` is not named `mod.*` (AZ's role table fails for any such policy without a column), a moderator may change the age gate and the posting restriction, no mutation deletes or removes a community, and icon and banner cannot be set while uploads are off.
- B1: the sensitive-content gate links a signed-in account without a 16+ declaration to `/settings/account`, where no declaration form exists (imported accounts will hit it; lane A or ADM); `PostView` has no `altText`, so an image post's alt text is its title; AZ's `postState` locks the post for every caller, so comment votes in one thread take turns on the post row; pages are `private, no-store` for every viewer.
- UI: `/auth/sign-in` loads 126.4 kB of script because `vendor-mux` is not tree-shaken (about 49 kB recoverable per route); the kit has 3.7 kB of room under the budget; lane A's native inputs are not yet swapped for the facade `TextField`, `Select` and `Checkbox`.
- FED-A: a poison event stalls the `federation.delivery` consumer; imported communities have empty outboxes until a backfill stores their Create activities; `deliveries` rows are never pruned (REM; since REM they are: settled ones after 30 days, see "Wave 2 batch B review fixes"); PieFed's day-one cap status and Lemmy's reaction to unknown software are measured live in wave 3; unexpected failures on federation paths answer 503 with `Retry-After`, never 500.

Housekeeping: no push; the worktrees, the lane branches, the lane databases and the `peblish:w2` image tag stay.

## Wave 2 batch A review fixes (2026-11-09)

Five fix branches, each cut from e886daf (pass one) in its own lane worktree, merged in this order with no conflict: B2 (a2253cd), F (a80e5a4), B1 (8b526e1), UI (789b8b3), FED-A (4cda027). Item numbers are the fixers' own ("Review fixes (2026-11-09)" in their lane notes, kept in `/Users/admin/.agents/plans/feddit/lane-notes/wave-2/<lane>.md`). The FED-A branch ended two commits past the head its brief named (a0c7099): e29310e and b437afb, both listed below.

B2 (head 85c106b, 6 commits):

- 1, 2 The cleaners check every kept structure's declared size and every frame; an APP14 suffix is cut to its 12 bytes instead of refused (196 real JPEGs carry private Adobe bytes there); GIF frames inside the screen with a legal code size, APNG frames inside the canvas, WebP animations with ANIM and one raster chunk per frame, and stricter DQT, DHT, DRI, DAC, SOF, SOS, IHDR, PLTE, tRNS, IEND CRC, GIF GCE and WebP pad bytes (13d6bbe; tests in `clean-structure.test.ts`, checked over about 50,900 local images, four deliberately broken GIFs newly refused).
- 3 A link preview nulls a `thumbnailUrl` or `urlContentType` that `NewPost.get(...)` would refuse (ab67441).
- 4 The proxy runs 32 upstream fetches at once and queues 64 more, then answers 503 with `Retry-After: 2` (d7d180b). The limit is per process, 320 MiB worst case at 32 by 10 MiB.
- 5 The proxy URL cap is 2,048 UTF-8 bytes on build and verify (b54fef0).
- 6, 7 `s3Store(config, { timeoutMs })`: one 30-second budget across retries; a timed-out put may still have landed (712659f).
- 8 README notes on the media limits, the proxy's reach and the link-preview throttle (85c106b).

F (head f8b25cd, 5 commits):

- 1 `listLocalCommunities` hides NSFL communities unless `includeSensitive` (75b5532).
- 2 `readCommunity(key, q?, hooks)` sanitises a remote Group's summary; images become links without a `rewriteImageUrl` hook (d7c9fc6).
- 3 `community.create` and `community.update` write modlog rows in the same transaction (9b86c89).
- 4 The owner posting case in the restricted-posting test (f8b25cd).
- 5 Icon and banner URLs are documented as raw (7a7413a).

B1 (head 9c9dc1a, 9 commits):

- 1 Posts in a deleted or removed community are left out of `postViews` for everyone, and `readPost` answers null (034ed9e).
- 2 `post.group_cannot_act` is refused before any lock in post.create, update, delete, restore and vote.cast (c5d1dbc).
- 3, 4, 6, 10 `storeRemotePost` and `updateRemotePost` share `editable()`, `post.id_conflict` for an ap_id under another author or community, a peer's url, thumbnail, content type and alt text pass the local validators, an identical Update writes nothing (9a4bb31).
- 5 `routes/post/-page-data.ts` holds `postMedia` and `threadVisible`, false for a removed post unless the viewer moderates (f15f411).
- 7 `createPost` refuses a non-local grant with `auth.required` (8d8c8d6).
- 8 A non-uuid post id answers 404 before the redirect (61f4464).
- 9 The author's self-vote logs a warning when it fails (4cca9f4).
- 11 The loader formats `published` and `edited` as strings; German hydration asserted in e2e (e90fa4b).
- A peer's post `language` is bounded by `peerLanguage`, a BCP 47 shape of at most 35 characters (9c9dc1a).

UI (head 22f0634, 10 commits):

- 1 `VoteControl` sends one request at a time and reverts a refusal to the last accepted vote (6e6f324).
- 2 Preference saves queue and each sends the complete `Prefs` (8cff78c).
- 3 `useMenuDismiss` closes only on later navigation (29bfe3f).
- 4 The drawer works before hydration through `:target` (d9de745); Safari and Firefox untested.
- 5 `Prose` makes inline spoilers keyboard operable (5bf5840).
- 6 `loadManifest` throws on a missing or invalid manifest unless `BASE_URL` is remote (37892eb).
- 7 Sign-up, reset, two-factor, verify, invite, account, security and registration are budgeted, with an inventory test over `routeTree.gen.ts` (4eb1333).
- 8 `PostCard` requires `thumbnailSrc: string | null` (11ec93f).
- 9 The gallery renders its bodies through the server Markdown renderer, so `/kit` needs the database (ebdff9b).
- 10 The budget measures compressible bytes; Traefik or Cloudflare compress in production (22f0634).

FED-A (head b437afb, 17 commits):

- 1, 12 Keys follow the fetched document and a deleted remote actor stays deleted (15fe483).
- 2 Peblish's own draft-cavage signer covers the full request target; Fedify is test-only (8fcc2be).
- 3 Delivery settlement is fenced on the claimed attempt and the lease renewed before sending (1157f2f).
- 4 The fetched id, the WebFinger name and the sigil are checked against the document (497dc24).
- 5 The key-refresh throttle counts attempts, per process, capped at 10,000 entries (4419bbe, e29310e).
- 6, 7 A follow is deleted only under the authorized Follow id, `receiveFollow` rechecks, and `follow.accept` carries `{ followApId, followerApId }` (1185012).
- 8 Actor GETs are signed with the instance key (1927535).
- 9 Only 408 and 429 retry among 4xx answers (205b4a8).
- 10 Resends pick by unfinished stage (137ca91).
- 11 `servable` includes `live`, deleted or removed content serves a 410 Tombstone, outboxes rebuild from current posts (6fc8107, b437afb).
- 13 NodeInfo is read whenever an instance's actor is resolved, a failed read not retried for 10 minutes (3ee3011).
- 14 The moderators collection applies `freshModerator` (ef8bd8e).
- 15 NodeInfo software name and version are capped and sanitised (97d0a9c).
- 16 The federation README describes all of it (a0c7099).

Statements these fixes made wrong, corrected here: "Fedify signs and verifies" (README, the architecture note above; signing and verification are peblish's own code and `@fedify/fedify` is now a dev dependency of federation), `PostCard` reading `post.thumbnailUrl` (it reads `thumbnailSrc`), B1's `-load.ts` helpers (now in `-page-data.ts`), and B1's removed-post copy "The comments below stay." (gone: the thread is withheld under a removed post for everyone but moderators and admins). Still true: a link preview stores the `og:image` URL as it is (now nulled when `NewPost` would refuse it). Left for later from the fixers: a partial index on `follows(created_at) where state = 'pending'` if follows grow; `isDormant` is still false and `deliveries` never pruned (REM; both are live since round 3); the proxy limit is per process and has no per-address limit; a timed-out S3 put can leave an orphan (SAFE); Mux `Dialog`'s English close label shows in German (a UI facade item, not fixed).

## Wave 2 round 2: D, C1, COMPOSER (2026-11-09)

Three lanes cut from e886daf, merged after the fixes; `LANE-NOTES.md` is removed in each merge commit (the notes are kept outside the repository). FED-B follows below, REM after it.

| Lane     | What it brought                                                                                                                                                 | Head    | Merge   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| D        | comment policies, mutations and remote counterparts, the thread read model with four sorts, the thread under the post, the permalink page and the comment forms | 23a83e0 | 12815d6 |
| C1       | the feed read model (Subscribed, Local, All, Popular, Moderating; Hot, New, Old, Top), keyset pagination, the five feed pages, the sidebar's lists              | e5313d3 | a2af0ef |
| COMPOSER | the Markdown editor and bottom sheet in `ui`, the `/submit` page, link previews on submit, the draft store, uploads behind `uploads.enabled`                    | 38c4cc2 | 45cd82f |

D's decisions and risks: `child_count` counts every comment below, at any depth (the parent chain updates in one statement, safe under the lock order, with a concurrency test); a delete changes no count (tombstones are counted); the author's upvote is cast at creation; `comment.group_cannot_act`; reply state copy for locked, deleted and removed posts is shown to everyone; 6 levels shown and at most 300 comments sent. Risks: no `comment` throttle scope, no "load more" past 300 comments, removal reasons come from the newest 200 modlog rows, a sort change fetches twice through the router.

C1's decisions and risks: Top's period as links, Old in the toolbar, Hot follows Lemmy past the week (older posts newest first), excerpts from `postViews`, defaults out of the URL so `/` never redirects, the closed-community filter lives in the feed SQL. Not built: Controversial, floated pinned posts, unread counts, a per-feed language filter. Performance: 133 cases over 100,000 posts (opt-in `PEBLISH_FEED_PERF`), worst p95 23.5 ms on a loaded machine, every key query on a `posts` index. Risk: Hot scans a week of posts per query (about 7,800 rows); a `hot_rank` column with a refresh job if the lab shows it.

COMPOSER's decisions and risks: a radio list with a filter for the community picker (works without scripts), remote communities listed only with an accepted follow, a link preview over its budget is refused as `rate.limited`, the sheet is shell state not a route (one rolling draft per community), uploads built behind `uploads.enabled` (nothing serves `/media/<id>` until SAFE). Risks: the picker's restriction flag for remote communities waits for FED-B's mirror, `document.execCommand` is the only way to keep Undo in a textarea, each e2e run spends about 3 of the 30 link previews per address per ten minutes.

Merge conflicts: only `packages/web/src/routes/post/-load.ts` (D's loader call against the B1 fix, kept both: `-page-data.ts`'s `postMedia`, `postTime` and `threadVisible`, and `thread: await loadThread(...)`) and the stale `siteMarkdown` import D's side carried. D's three mount lines in `post-page.tsx` merged on their own. `pnpm-lock.yaml`, `README.md`, `G0-STATUS.md`, `deploy/README.md` and `e2e/payload/routes.ts` merged without conflict. The UI fix did not touch `shell/data.ts` (C1 owns it). B1's removed-post copy "The comments below stay." is gone from `i18n/posts.json` in both languages (the deleted-post copy keeps it: a tombstone's comments stay). D's `threadShown` repeats B1's `threadVisible` rule; it can import it later.

Integration commits, after the merges:

| Commit  | Change                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16c0208 | The feed loader no longer overwrites `post.thumbnailUrl`; the root loader passes its session to `loadShellData`                                      |
| 9ac0188 | JIT off for the read pool (`jit: 'off'`, a string because postgres.js drops a falsy startup value) and a test that pins both pools' settings         |
| f9619ce | The post card's title link is 24px high, in the component; the feed's margin workaround is gone                                                      |
| 8b2a78f | Migration `0005_wave_2_round_a` and the two indexes (round 3 folded it into `0005_wave_2_pass_two`)                                                  |
| 0a6f00d | `ReplyBar` catches a rejected `onSubmit`, so a refused reply keeps its text                                                                          |
| 68cc744 | `emailUnverified` is one helper in `authz/roles.ts`, called by the post and comment policies                                                         |
| 74fdb9c | Comments: `childCount` counts every comment below, and `ModAction.action` names the `community.*` actions                                            |
| b919b07 | `@fedify/fedify` moves to federation's `devDependencies`                                                                                             |
| 55ba9a7 | `e2e/payload/routes.ts`: `/all`, `/local`, `/popular`, `/moderating`, the comment permalink and `/submit`; the comment forms' endpoint in `notPages` |
| 58d50dc | The phone drawer is pinned to the screen height (below)                                                                                              |
| e6786f5 | The feed's page data carries `thumbnailUrl: null` (below)                                                                                            |
| 1ffea94 | Four e2e specs adjusted for the merged tree (below)                                                                                                  |
| c514872 | README (ownership rows for D, C1 and COMPOSER, the Fedify statements), this section                                                                  |

Migration `0005_wave_2_round_a`, generated once by drizzle-kit after the merges and the index edits (round 3 replaced it with `0005_wave_2_pass_two`, which holds these two indexes and REM's tables and indexes; as generated here it held exactly the two indexes and nothing else):

- `posts_score` on `posts`: `((upvotes - downvotes)) DESC NULLS LAST, id DESC NULLS LAST`, for the score sorts (Top over a week or more, Popular's deep pages: 40 to 190 ms down to about 3 ms).
- `actors_gated` on `actors (id)` where `sensitive or nsfl`, so the feeds' NSFW predicate is an index-only scan of the few gated communities instead of a sequential scan of every actor.
- No table, column or trigger. `pnpm db:drift` finds none. FED-B added no table; REM may, and regenerates it then.

Found by the e2e run on the merged tree, fixed in the integration commits:

1. The phone drawer was unreachable below the fold once the sidebar listed many communities (C1's lists, 25 on the lane database). The desktop rule's `align-self: start` made the fixed drawer as tall as its content instead of top-to-bottom, and the overflow never scrolled. The mobile rule now sets `align-self: stretch`.
2. Dropping the thumbnail overwrite put the raw `thumbnailUrl` of every feed post into the serialised page data, which C1's own spec (a remote picture's address is never in the page) caught. The loader sets it to null; the card draws `thumbnailSrc`.
3. The uploads spec's post sits at `<PUBLIC_ORIGIN>/media/<id>`, and the lane's origin does not resolve, so the home feed (now a real feed) broke the hydration spec with `ERR_NAME_NOT_RESOLVED`. The spec deletes its post at the end. The product-level answer, `imageSource` returning own-origin media as a root-relative path, landed in round 3, and the spec no longer deletes its post.
4. The composer spec's "no search box" check, the shell's "Local" link and the pagination spec's overlap check each met the merged tree's new sidebar search box, `feeds_local_*` communities and repeated titles; they now scope to the composer's box, match exactly and compare links.

Dependencies accepted: none added. `@fedify/fedify` 2.4.5 moved from `dependencies` to `devDependencies` in federation (the lockfile changed in that one place; `pnpm install --frozen-lockfile` is up to date).

Requests from the lanes not applied here: the community page (`routes/c/**`) does not exist yet, so F's `readCommunity(..., { rewriteImageUrl: renderer.image })` call and the icon and banner through `renderer.image()` go in with the lane that builds it (DISC); COMPOSER's `/submit?community=` link waits for the same page; D's optional `CommentThread` actions slot, COMPOSER's optional `followedCommunities` host and restriction fields, and the Mux `Dialog` close label in German stay open.

Verification of round A, on lane root:

- `pnpm install --frozen-lockfile` is up to date; `pnpm check` is green: 124 test files (122 passed, 2 skipped), 1,747 tests passed and 3 skipped (FIT's opt-in build and archive tests, C1's opt-in performance test), no boundary violations (593 modules), oxlint and Prettier clean. No `worker.test.ts` timeout and no rerun was needed.
- `pnpm db:drift`: none, with 0005 applied to `peblish_root`.
- `PEBLISH_UI_KIT=1 pnpm e2e`: 194 passed, 1 skipped (the test that `/kit` answers 404 where the gallery is off). The first run on the merged tree found the four fixes above (five specs failed); the runs that followed met a repeated title in the pagination spec and then the sign-in throttle after three full runs from one address (cleared with `delete from throttles` on the lane database), and the last run was clean. Payload, first visit, of the 170 kB script budget: `/`, `/all`, `/local`, `/popular`, `/moderating` 62.8 kB; the auth, invite, settings and admin pages 126.3 kB; `/post/<id>` and the permalink 127.3 kB; `/submit` signed out 126.3 kB and signed in 129.4 kB (the sheet adds 106.1 kB lazily, of 200); `/kit` 168.8 kB, 1.2 kB of room. CSS 60.4 of 65 kB everywhere; fonts 105.6 kB, the kit 259.2 of 270 kB.
- `docker build`, then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate (0005 applied), the first admin, the worker starts and stops on SIGTERM with exit 0, web `/healthz`, `/readyz` and the healthcheck, uid 1000. A rerun on the same database passed too. The image is tagged `peblish:w2-round-a`.

## Wave 2 round 2: FED-B (2026-11-09)

Lane FED-B (head 91eef16, cut from e886daf; it merged `mvp-w2` at 55ba9a7, the end of round A's first commits, into its branch before reporting) merged as 8932230 with no conflict; `LANE-NOTES.md` is removed in the merge commit and the notes are kept in `/Users/admin/.agents/plans/feddit/lane-notes/wave-2/fed-b.md`. It adds no table and no migration, and no dependency. It brought the inbound half of ActivityPub:

- Receipt replaces the 503 stub: the signature is verified, the exact bytes go into `inbox_raw` with the signed headers, and the answer is 202 (400 not an activity, 401 bad signature or a key whose owner is not the actor, 413 over 512 KiB, 429 too many unknown-key fetches, 503 with `Retry-After` when `inbox.enabled` is off or storage fails).
- One pipeline (`federation.inbound`, leases with `SKIP LOCKED`): classify, map, `prepare` (all network), then one transaction for dedupe, apply, the `activities` row, the relay, the requeue of rows waiting on the object and the row's end state. A skip or refusal rolls it back and records the bare reason; a mapping error is `failed` and never retried; anything else backs off and fails after 8 tries.
- The authorization matrix runs 16 of 16 (N0 to N15, exact reasons, state unchanged on every refusal). Handlers cover Announce (including PieFed's batched form), Create, Update, Delete, Undo, Like, Dislike, Lock, Add, Remove, Block, Follow, Accept and Reject. Inbound Lock, featured Add and Remove, and community Block (with their Undo) apply, inside a remote community's Announce and straight to a local community from a moderator appointed there. Flag is a stub that authorizes the report and skips with `flag.not_handled` until REP.
- The relay announces what reaches a local community to its remote followers (the received bytes spliced unchanged into the Announce; `Announce(Page)` for Mastodon-like followers) and federates local `mod.remove`, `mod.lock`, `mod.feature`, `mod.ban`, `mod.role` and a local account's deletion. The remote moderators mirror (`remote/moderators.ts`, policy `remote.moderators_mirror`, job `federation.moderators` every 15 minutes) writes `source: 'remote'` rows verified at mirror time and expiring in 12 hours.
- Comments go through D's remote mutations; the shim FED-B carried is gone.
- The corpus replay (every inbound and peer-log document of the Phase 0 captures, Lemmy 71 and PieFed 35) ends with 106 documents: 36 applied, 70 skipped with a recorded reason, 0 failed, none left pending.

Decisions: a Group sender is skipped as `actor.group_cannot_act` before anything is built (B1 and D refuse the same later, so the two agree); an Accept that names its Follow by IRI only is skipped as `accept.unverifiable`; `Undo(Follow)` removes the follow with `apId: null` because Lemmy mints a fresh Follow id inside its Undo (LAB confirms); a remote Group's `summary_html` is stored raw and sanitised only on read (`readCommunity`); direct content in a remote community is skipped (`community.unannounced`), it counts only in that community's own Announce. Accepted edits outside its write set: `e2e/server/federation.spec.ts` and `packages/federation/src/http.test.ts` expect a 401 from an unsigned inbox POST instead of the stub's 503, and `packages/federation/README.md`.

Risks and hand-offs: the inbound throttle is per process; `inbox_raw` grows without bound until REM prunes it (REM prunes settled rows after 14 days); a first delivery of one object into two communities that race can raise a unique violation, which is retried, not lost; a missing object is not fetched (votes and edits for a post never seen wait with `target.missing`, and `requeueSkippedFor(apId)` releases them); the first mirror of a newly followed community waits up to 15 minutes unless REM calls `mirrorNow`; the mirrored moderators' modlog rows are non-public. For the wave 3 lab: PieFed serving `/activities/...`, a real Lemmy accepting the relayed Announce byte for byte, a Mastodon-like follower receiving `Announce(Page)`, a live moderator add and remove with the 12 hour expiry, and the Undo(Follow) shape.

Verification of round B, on lane root with FED-B merged (the tree after round A's commits plus 8932230):

- `pnpm install --frozen-lockfile` is up to date; `pnpm check` is green: 130 test files (128 passed, 2 skipped), 1,808 tests passed and 3 skipped, no boundary violations (636 modules), oxlint and Prettier clean. `pnpm db:drift`: none.
- `PEBLISH_UI_KIT=1 pnpm e2e`: 194 passed, 1 skipped. One run in three failed on the sign-in throttle: three specs that sign in were refused with "Too many attempts" because `sign-in` allows 10 per client address in 15 minutes and a full run leaves 9 of them counted (the specs that fail on purpose; the table showed 12 in the failing run, with sign-ins in flight at once). Clearing `throttles` on the lane database and rerunning was clean, as was the run before it (round 3 clears them in a Playwright global setup). Payload figures are the same as in round A.
- `docker build` (tagged `peblish:w2-round-b`), then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): all steps passed, and a rerun on the same database passed too.

## Wave 2 round 3: REM (2026-11-09)

Lane REM (head e8c89ee, cut from 91eef16, FED-B's head; it merged `mvp-w2` at 9fa24ec into its branch) merged as 2857c61 with no conflict; `LANE-NOTES.md` is removed in the merge commit and the notes are kept in `/Users/admin/.agents/plans/feddit/lane-notes/wave-2/rem.md`. It brought:

- **Cache figures as data and fetching on purpose** (`federation/src/remote-fetch/`): `remoteTtls` (an actor is fetched again after 24 hours, a down peer keeps the copy, NodeInfo after a day, a rotated key is found with one refetch), `fetchRemoteObject` and `refreshRemoteActor` (a 410 or a Tombstone is a deletion, a valid document brings a deleted actor back), one request at a time per host with a 300 ms gap (`polite.ts`), and the job `federation.missing_objects`, which fetches the objects skipped activities wait for (newest first, 25 a run) and requeues them. Both the slice 3 case, a Dislike on an older post, and a comment with a missing parent now apply.
- **FEP-7888 backfill** of a followed remote community (`federation/src/backfill/`, `core/remote/backfill.ts`): a consumer queues it on `follow.accepted`, the job `federation.backfill_run` reads the featured and outbox collections and then the comments, within caps (50 posts, 100 comments a post and 500 a community, 3 pages, 250 requests, a 15 minute lease, two retries).
- **Remote deletion** (`core/remote/actors.ts`): `deleteRemoteActor` with or without the account's content, `undeleteRemoteActor`, one `deletion_ledger` row per deleted account (`details.removeContent` tells a restore to delete the account's content too) and a `post` or `comment` row for one object gone at its source.
- **Dormant instances** (`core/remote/dormant.ts`, table `instance_health`, job `remote.instance_health` every 10 minutes): a peer with at least 3 failed deliveries in an unbroken run since its last delivered row, the earliest 7 days old, that sent us nothing in 7 days, is skipped except for one probe delivery a day; a delivered probe or any inbound activity revives it.
- **Pruning** (job `remote.prune`, hourly): settled `inbox_raw` rows after 14 days and settled `deliveries` after 30, 2,000 rows a transaction; a pending row is never deleted.

Decisions: a fetched object is stored only under a vouch, that is, the community served it from its own collection or announced an activity about it (core's `post.create` and `comment.create` read it as a community Announce); an embedded object is trusted only from its own server; featured posts are stored, not pinned (pinning writes a modlog row, so the live `Add` still pins and a community's pins are missing until its next `Add`); the inbound NSFW refusal (`content.nsfw_rejected`) is repeated in one line in `remote-fetch/object.ts` and must change in both places when ADM adds the setting; the Delete(Person) wiring below; the missing-object job remembers what it asked for in memory, per process.

What the corpus does and does not show (the questions for LAB): both Lemmy 0.19.21 and PieFed 1.8.11 advertise `outbox` and `featured` on a community's Group, but the corpus holds no outbox or featured collection, so the shape the backfill reads is the one FED-A serves (an `OrderedCollection` of `Create(Page)`, or of `Page` objects) plus `first` and `next` paging; across every Page and Note captured there is no `context`, `replies` or `comments` property, so neither software publishes a collection of a post's comments and the backfill's comment step finds nothing from them (a comment arrives live or by IRI through `missing.ts`); a Lemmy outbox is only the last 20 or so posts, so an older post a Dislike names comes from the missing-object job.

Root's edits from REM's section 5, made here: `prepareActorDelete` passes `{ removeContent: ctx.raw.removeData === true, cause: 'Delete' }` (Lemmy's "delete my content" sets `removeData` on the Delete), with a pipeline test for with and without; Undo of an account's own Delete calls `undeleteRemoteActor` instead of skipping as `undo.unsupported`; `resolveId` deletes a held actor when its refresh answers 410 (cause `Tombstone`), with a test; the four indexes below; the README row and the federation README layout rows.

Migration. Round A's `0005_wave_2_round_a` was deleted (file, snapshot, journal entry) and `pnpm db:generate` run once, giving the single wave 2 pass-two migration `0005_wave_2_pass_two`. It equals REM's scratch SQL for the tables (checked against it) plus the other indexes, and drift is none:

- `backfills` (`core/remote/tables.ts`): primary key `community_id` (foreign key to `actors`, ON DELETE cascade), `state` (check: `pending`, `running`, `done`, `failed`), `attempts`, `next_attempt_at`, `lease_until`, `queued_at`, `finished_at`, `posts`, `comments`, `note`; index `backfills_due` (partial, `next_attempt_at` where `state in ('pending', 'running')`).
- `instance_health`: primary key `instance_id` (foreign key to `instances`, ON DELETE cascade), `state` (check: `active`, `dormant`), `failing_since`, `dormant_since`, `revived_at`, `last_probe_at`, `updated_at`.
- C1's `posts_score` and `actors_gated` (round A).
- REM's four recommended indexes: `deliveries_delivered` (`instance_id, settled_at` where `state = 'delivered'`) and `deliveries_settled` (`settled_at` where `state <> 'pending'`) on `deliveries`; `inbox_raw_actor` (`actor_ap_id, received_at`) and `inbox_raw_processed` (`processed_at` where `state <> 'pending'`) on `inbox_raw`. At 400,000 deliveries and 300,000 inbox rows they take the health job and the prune from 40 to 200 ms a run to under 2 ms.
- No column on an existing table and no trigger. `peblish_root` was dropped and recreated, since it carried the old 0005.

Also in this round, from round A's leftovers: `imageSource` returns this instance's own media as a root-relative path (the viewer may reach the instance under another host than `PUBLIC_ORIGIN`; a test covers the path, the query and a different port), the post page's data carries `thumbnailUrl: null` as the feed's does, a Playwright global setup (`e2e/global-setup.ts`) empties the lane's throttle counters before a run (CI databases are fresh, so this only serves repeated local runs), the sign-in limit spec signs in from its own client address (the e2e server trusts `X-Forwarded-For`), which cured the flake that remained (three specs refused in two of four runs, with 127.0.0.1 ending a run at 12 of 10; now 3 of 10), and the README tagline no longer names Fedify as a dependency.

Risks and hand-offs: the backfill and the missing-object job are the first code to fetch objects a peer did not send in a signed POST (every fetch goes through `safeFetch` and is bounded; a hostile community can make us read up to 50 posts and 250 requests per follow); politeness is per process; the dormancy probe is a real delivery, so a peer that was down for a week misses a week of our activities even after it returns (`skipped` is final); `activities.raw`, `posts.raw` and `actors.raw` keep peer JSON beyond the 14 days (a takedown must clear them too, for SAFE); `inbox_raw` retention removes the bytes a later byte-for-byte re-relay would need (there is no such re-relay). For the wave 3 lab: capture a Lemmy and a PieFed community's `outbox` and `featured` and a Page from each; reproduce the slice 3 Dislike through `federation.missing_objects`; delete a Lemmy account with and without "delete content" and confirm `removeData`; confirm what a deleted user, community, post and comment answer when fetched (a 410 with a Tombstone body, or a Tombstone with 200, both are deletions; a plain 404 is a refusal); watch `instance_health` and the one probe a day against a peer behind a refusing port; confirm Lemmy and PieFed answer the signed GET of `/post/N` and `/comment/N`.

Verification of round 3, on lane root with REM merged:

- `pnpm install --frozen-lockfile` is up to date; `pnpm check` is green: 141 test files (139 passed, 2 skipped), 1,865 tests passed and 3 skipped (FIT's opt-in build and archive tests, C1's opt-in performance test), no boundary violations (667 modules), oxlint and Prettier clean. `pnpm db:drift`: none, on a recreated `peblish_root` with `0005_wave_2_pass_two` applied.
- `PEBLISH_UI_KIT=1 pnpm e2e`: 194 passed, 1 skipped, on two clean runs in a row after the sign-in change. Payload is the same as in round A: 62.8 kB of script on the five feed pages; 126.3 kB on the auth, invite, settings, admin and signed-out `/submit` pages; 127.3 kB on `/post/<id>` and the permalink; 129.4 kB on `/submit` signed in (the sheet adds 106.1 kB lazily, of 200); 168.8 kB on `/kit`, 1.2 kB of room. CSS 60.4 of 65 kB, fonts 105.6 kB, 259.2 of 270 on `/kit`.
- `docker build` (tagged `peblish:w2-final`), then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate (0005 applied), the first admin, the worker starts and stops on SIGTERM with exit 0 (it now runs REM's consumer and four jobs), web `/healthz`, `/readyz` and the healthcheck, uid 1000; a rerun on the same database passed too.

## Wave 2 complete (2026-11-09)

`mvp-w2` holds all of wave 2 on top of wave 1: lanes B2, F, B1, UI and FED-A (pass one, migration 0004), the five batch A review fixes, lanes D, C1 and COMPOSER, then FED-B and REM, with one wave 2 pass-two migration, `0005_wave_2_pass_two` (C1's two indexes, REM's `backfills` and `instance_health` and four indexes on `deliveries` and `inbox_raw`). Everything is committed and nothing is pushed. The final batch is `e886daf..HEAD`; the lanes' notes are in `/Users/admin/.agents/plans/feddit/lane-notes/wave-2/`.

What the next steps take as input: the batch B review (Codex by concern plus the find-and-verify workflow on `e886daf..HEAD`), the wave 3 live lab with the questions each lane listed above, SAFE (scanning and serving `/media/<id>`, clearing peer JSON on a takedown), DISC (the community page, `/resolve`, the `readCommunity` image hook), ADM (the remote NSFW and uploads settings, which today are the two places `content.nsfw_rejected` is decided), REP (the Flag handler), MODF (instance blocks) and the C1/D follow-ups (Hot's week scan, comment throttle and "load more", pinned posts). The open performance risk is Hot's scan of a week of posts per query; the open product gaps are the ones in the lanes' "Left open" lists.

## Wave 2 batch B review fixes (2026-11-09)

The batch B review of `mvp-w2` at 644a0d8 (four Codex reviewers by concern and a 30-agent find-and-verify workflow; 63 raw findings, 9 confirmed, 1 disputed, 53 P3) was fixed in nine lanes, each a branch `mvp-w2-fix2-<lane>` cut from 644a0d8 with its own worktree, and merged here in contract order with `git merge --no-ff`, with no conflict in any of the nine: fed-a 5c8974d, rem 850aec1, fed-b fad02bd, b2 b3bf4f5, b1 5ef1c2b, d 8579d69, c1 a14a195, composer 210f86b, ui 3a8a75a. No lane added a dependency (`pnpm-lock.yaml` is unchanged) or edited `README.md` or this file. The lane briefs and reports are in `/Users/admin/.agents/plans/feddit/briefs/wave-2/fixes-batch-b.md`.

Item to commit, by lane (items are numbered as in the brief):

- **FED-A** (head bb7e145): 1 serving a local activity checks the held content's state whoever wrote it, so a relay Announce of a deleted, removed or unheld Page or Note answers the 410 Tombstone (2edff8a); 2 a 200 Tombstone bound to the request takes the 410 path (70765cf, bb7e145); 3 `RemoteActorKindError` becomes `ActorResolveError('invalid')` and `@` accepts Service actors (559b42e); 4 `fetchActivity(url, fetch, { maxRedirects = 0 })` returns `{ json, url, hops }` (598bdef); 5 `followedCommunities` returns `host`, `postingRestrictedToMods`, `sensitive`, `nsfl` and leaves out removed communities (9121e87); 6 the NodeInfo failure cache expires and is capped (ac134e9); 7 the key-refresh throttle stores a hash, and GoToSocial key ids resolve through `owner` (31f5c5c); 8 a delivery whose handling throws is retried and ends `failed` at attempt 10 (ede3eb3); 9 in-flight resolutions are keyed by freshness (9a90796); README 7c51e14.
- **REM** (head d46ce8c): 1 and 2 `readObject` binds the fetched id to the request (`object.id_mismatch`), backfill collections yield only what reaches the expected post (1d044af); 3, 4 and 5 `deleteRemoteActor(grant, { removeContent, cause })` in ordered transactions returning `{ actorChanged, contentRemoved }`, refresh keeps a signed Delete, Person and Service flip in the upsert (e5fc650); 6 and 7 missing-object job paging, eligibility and memory (8d6ab58); 8 backfill claim fencing (5a7f12d); 9 prune with `FOR UPDATE SKIP LOCKED`, now also `inbox_dedupe` and `throttles` (9e30ab4); 10 the daily recheck job (e18bb1f) and dormancy counted from `failing_since` (5ed8ed0); ledger names and README d1717a8, d46ce8c.
- **FED-B** (head b3fb0d8): 1 Updates checked against the stored row (c2e0707); 2 intake limits, repeat receipts and separate fetch budgets (a0b2e2e); 3 `announce.nested` (43e995f); 4 an announced Update(Group) keeps the stored key (96b3d2a); 5 Delete and Undo senders resolved with the copy we hold (88fb92d); 6 per-member outcomes (e41e6a6); 7 the moderators mirror (8f01dc5); 8 claim generations and renewed leases (073bbba); 9 ledger rows for author Deletes, `community.delete_unsupported`, a gone account's Delete answered 202 (bdfadf9); 10 pinned corpus outcomes, strict UTF-8, a rewritten Note relayed as its Page (a0ed7af, 89e747c, b3fb0d8).
- **B2** (head 5a2ad2d): 1 `imageSource` keeps a root-relative path only for `/^\/(?![/\\])/` (39d30ea); 2 palette `tRNS` bounded by the palette (4cff953); 3 an aborted proxy waiter leaves the queue (e9f0859), JPEG table caps (5a2ad2d).
- **B1** (head f649410): 1 and 4 `updateRemotePost` refuses a mismatched object IRI and ignores an older Update (bbbd4b2); 3 the page data's root-relative pattern (af5752e); 2 `<main key={post.id}>` (f649410).
- **D** (head cafa149): 1 `restoreComment` (c16e6ca); 2 and 3 cursor-paged siblings selected in the sort's order (3b2d00f, e7fca97); 4 the Group guard before `commentState()` (acd884b); 5 the `comment` throttle scope, the id check before the redirect, the lock protocol documented (5b20b16), the permalink page keyed by post and comment (cafa149).
- **C1** (head 8ec04b6): 1 cursor validation (c3a5991); 2 image posts send only the URL's origin (821aaa1), no cookie fallback in `loadShellData` (3fb8d5e), the performance test uses the migration's indexes (8ec04b6).
- **COMPOSER** (head 0dfd504): 1 drafts keyed by actor and community (86c4778); 2 the picker and the panel apply the removal and age predicates (14523bc); 3 a refused no-JavaScript submission keeps its values in a viewer-scoped flash, authorization runs before the preview fetch and the upload (0dfd504).
- **UI** (head 99b241d): 1 the drawer adopts a pre-hydration `:target` once (d7b687a); 2 spoilers holding a link or another spoiler stay spans with a separate reveal button (34f2655); 3 the payload manifest is validated (d06285f); 4 tab sync of the viewer (fb59076), the `/submit` payload entry documented (e4e6614), the kit's content function refuses when the gallery is off (99b241d).

Root's integration, after the nine merges (commits 1a84dcf, fa38f70, b88b71b, e1e53bb, aeededc and the one that adds this section):

- The four `// integration:` adapters and the two `test.todo`s FED-B left are gone: `handlers/delete.ts` imports `recordDeletion` and `recordRestoration` from `@peblish/core/remote/ledger` (FED-B's `inbound/ledger.ts` is deleted), calls `deleteRemoteActor(grant, { removeContent, cause: 'Delete' })` in `prepare`, outside any transaction, and `restoreComment.within(t, grant)` for an author's Undo(Delete) of a comment; `moderators/refresh.ts` calls `fetchActivity(collection, fetch, { maxRedirects: 0 })`; the two tests are an author's Undo of a comment Delete (ledger `remote.object_deleted` then `remote.object_undeleted`) and a Delete with `removeData` for an account a Tombstone already deleted (applied, its posts deleted). The composer's `followedRemote` adapter is replaced by the `followedCommunities` fields (remote Groups with an accepted follow, handle `name@host`), and the `communityId` alias is dropped from `followedCommunities` since nothing reads it.
- `post.id_conflict` now reads "This ActivityPub id names a post that exists under a different id, author or community." (Create and Update).
- REM's `RemoteActorKindError` sets `name = 'RemoteActorKindError'`, so FED-A's match by name in `isKindError` (`actors/resolve.ts`) holds and stays.
- `e2e/shell/viewer-sync.spec.ts` (UI's) raced: its last step showed the stale tab again as soon as the other tab's URL was `/` after signing out, before that tab's post-hydration effect had written the signed-out viewer, and failed four runs in four on the merged tree (it passed in UI's lane); it now polls the shared `pb-viewer` record at each step (aeededc). The product code is unchanged: a real tab is shown again long after hydration.
- The README ownership table, `deploy/README.md` (the `comment` budget, the prune windows, the composer flash lives in one web process) and the federation README's inbound section are brought up to date.

Statements the fixes made wrong: dormancy is live (`isDormant` is no longer false) and `inbox_raw` (settled rows, 14 days), `deliveries` (settled, 30), `inbox_dedupe` (90) and `throttles` (1) are pruned, which makes "`deliveries` never pruned", "`inbox_raw` grows without bound" and "old `throttles` rows are not pruned" (wave 1 and rounds A and B above) out of date; "the missing-object job remembers what it asked for in memory, per process" still holds, now keyed by community and object with a cap and expiry, and the federation README's inbound section (receipt answers, no limits per signer) is rewritten.

Migration `0006_wave_2_fixes` (generated once, read before committing, `pnpm db:drift`: none): `object_rechecks` (`object_id` uuid primary key, `checked_at` timestamptz not null) with index `object_rechecks_checked (checked_at)`, equal to REM's scratch SQL, plus three indexes added to the Drizzle tables first: `deletion_ledger_subject (subject_kind, subject_id)`, `inbox_dedupe_seen (seen_at)` and `throttles_window (window_start)`. No column on an existing table and no trigger. No other lane added a table, column or index.

For the restore drill (B06): the ledger's reasons are now `remote.object_deleted` (an author's Delete of a post or comment), `remote.object_undeleted` (the author's Undo), `remote.object_gone` (a 410 or Tombstone for an object), `remote.actor_deleted` and `remote.actor_undeleted`; applied in id order, the later row takes the earlier one back, and `details.removeContent` on an actor row tells a restore to delete the account's content too.

Rollout note for dormancy: it now counts from `instance_health.failing_since`, so an instance that is already failing when this deploys starts its seven-day clock at its first health run, not retroactively.

Decisions: a no-JavaScript refused form keeps its typed words in a flash in the web process's memory (10 minutes, 2 per person, 100 overall), so a second web replica or a restart loses them for that one redisplay (stated in `deploy/README.md`); the composer's picker still lists only accepted follows although `followedCommunities` also returns pending ones; a stale-Update check against a receive-time `editedAt` can ignore a real older edit from a peer that never sent `updated` (all three peers send it); a permalink's reply bar text carries over between permalinks but vote state does not; the dormancy probe is returned after an hour when unused, strict consumption would need a hook in `delivery/run.ts`; `RemoteActorKindError` is matched by name in federation.

For the wave 3 lab, from the lanes: GoToSocial key documents and 200 Tombstones; peers accepting `Announce(Create(Page))` made from a rewritten microblog Note; BOM or invalid UTF-8 bodies; Announce of Announce in the wild; Mastodon stopping after the 202 for a gone account's Delete; moderators collections served without redirects; the intake numbers (300 and 1,200 requests a minute, 8 and 32 MiB pending) against real rates; key rotation arriving in the Group's own Update; the missing-object job walking up to 2,000 waiting objects a run; the recheck job's pacing (100 a run, once a day each); a plain 404 on a held object is a refusal, not a deletion. Open from the lanes: an index on `comments (post_id) where parent_id is null` if a very large post reads slowly (41,400 comments read in about 20 ms without it); a signed-out no-JavaScript POST to `/submit` still loses its typed words (no viewer to scope the flash to); the Hot first page of the 500-comment seed no longer reaches level 6, so the budget test uses Old; the same Firefox PNG doubling of `tRNS` is now tolerated (the first chunk is kept); two JPEGs of 32,292 are newly refused (Mozilla's 1,000-scan stress image).

Follow-up review of this batch (a Codex reviewer and the 11-agent `w2c-review.js` workflow on 644a0d8..1b3303d): done. The workflow confirmed every P1 and P2 item closed as integrated in all nine lanes, and found one P2 regression (the comment thread's fetch effect, fixed in `fix3-d`) and 21 P3. Codex confirmed every other P1 closed and found four P1 gaps and six P2 in the fixes; root fixed all of them, and the P3 that were regressions or bounded, in four more lanes (the section "Wave 2 batch B follow-up fixes" below). Those fix3 commits carry root's checks only: no further review round ran, and the PR says so; Andrew may ask for one.

Verification on lane root with all nine merged (head at the time of the last run is the commit before this section):

- `pnpm install --frozen-lockfile` is up to date (no lockfile change); `pnpm check` is green on the first run, with no load flake: 155 test files (153 passed, 2 skipped), 2,047 tests passed and 3 skipped (FIT's opt-in build and archive tests, C1's opt-in performance test), no boundary violations (690 modules), oxlint and Prettier clean. `pnpm db:drift`: none, on a database migrated through `0006_wave_2_fixes`.
- `PEBLISH_UI_KIT=1 pnpm e2e`: the first run was 213 passed, 1 failed (the viewer-sync race above) and 1 skipped; after aeededc it is 214 passed, 1 skipped. Payload is unchanged from round 3: 62.8 kB of script on the five feed pages; 126.3 kB on the auth, invite, settings, admin and signed-out `/submit` pages; 127.3 kB on `/post/<id>` and the permalink; 129.4 kB on `/submit` signed in (the sheet adds 105.8 kB lazily, of 200); 168.8 kB on `/kit`, 1.2 kB of room. CSS 60.4 of 65 kB, fonts 105.6 kB, 259.2 of 270 on `/kit`.
- `docker build` (tagged `peblish:w2-batch-b`), then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate (seven migrations applied, `object_rechecks` and the three new indexes present), the first admin, the worker starts and stops on SIGTERM, web `/healthz`, `/readyz` and the healthcheck, uid 1000; a rerun on the same database passed too.

## Wave 2 batch B follow-up fixes (2026-11-09)

The follow-up review of `mvp-w2` at 1b3303d was fixed in four lanes, branches `mvp-w2-fix3-<lane>` cut from 1b3303d, merged here with `git merge --no-ff`, with no conflict: d 375b9e3, composer 4af4a47, rem bec2aba, fed-b 218e40b. Root added adcfecb (the sidebar footer links are 24 px targets, so wrapped German labels pass axe, the CI failure) and the integration commits listed below. No lane added a dependency, a table, a column or an index. The briefs and reports are in `/Users/admin/.agents/plans/feddit/briefs/wave-2/fixes-followup.md`.

Item to commit, by lane (the review finding in brackets):

- **D** (head 284446e): 1 the fetch effect of the thread has `loaded` in its deps again and draws a fetch only when its `sort` and `after` match the view, so a reply on `?sort=old` or an `?after=` page refetches (two e2e cases, both fail without it) (b28d215); 2 a comment that is both deleted and removed hides its author like a deleted one (284446e). The moderators' "Removed by moderators" list still shows the handle.
- **COMPOSER** (head ec5d641): 1 [Codex P1 1] the composer page and the sheet are keyed by the viewer's actor id, the edit target and the flash, so a changed account (sign-out and sign-in, or the viewer sync from another tab) starts a fresh form and the sheet reloads its account-scoped data; `e2e/composer/viewer.spec.ts` (ec5d641).
- **REM** (head 6664b43): 1 [P1 3] inline `context` and `replies` collections are origin-checked like IRI ones, and an embedded object is trusted only on the origin of the document that carried it (2d9b6c9); 2 [P2 7] a Tombstone naming another id no longer deletes the requested actor on refresh (ed5adf9); 3 [P2 8] the missing-object scan leaves out own-origin, settled and backed-off targets in the query, before its limit (fee584e); 4 [contract] `storeRemoteActor.within(t, grant, { ...input, keys: false })` stores the profile only and never reads or writes `actor_keys` (9126b1b); 5 the recheck claim reads at most `limit` stale marks plus `limit` never-asked objects per kind, and marks go with deleted objects (90e75b6); README 6664b43.
- **FED-B** (head 2c9f961): 1 [P1 2] an exhausted fetch budget is a wait that costs no attempt: the row is pending again after 5 or 30 seconds, a batch member starts with at least six fetches left, and a 200-member batch over new origins completes across claims (8825639); 2 [P1 4] unknown-key discovery has its own admission, charged once per lookup to the client address first and then to the host (10 an address, 20 a host, 120 in all), apart from refreshes of held actors (10, 30, 200), at most eight fetches a lookup (47d7508); 3 [P2 5] a moderator's announced Update(Group) keeps a key rotated meanwhile (d34b8da); 4 [P2 6] every batch member's applying transaction asserts the claim generation (ef78f11); 5 [P2 9 and 10] a repeat is recognised before the intake allowance is charged, and repeat check, pending bytes and insert are one step per instance under an advisory lock (30505d8); 6 [P3] an unreachable moderators mirror is deferred an hour and a failing one fifteen minutes, and a batch names every missing object in its error (2c9f961).

Root's integration, after the four merges (commits f0352bf, 7d9aa28, 4ef3a42, f1bea5f, adc7ada, the test fix 0301e06 and the two that add the documentation):

- The adapter FED-B left is gone: `inbound/handlers/update.ts` stores an Update(Group) announced by someone other than the Group with `storeRemoteActor.within(t, grant, { ...record, keys: false })` (the local `storeProfileOnly` and its key read are deleted; the interleaving test, a rotation holding the row while the update waits, stays and passes) (f0352bf).
- `remote-fetch/missing.ts` splits a multi-target error `target.missing <id1> <id2> ...` into one row per target (`cross join lateral regexp_split_to_table(...)`, `distinct on (target, community)`), so every object a batch waits for is fetched; a two-target row with one own-origin target is tested (7d9aa28).
- `signing/inbound.ts` records an actor's once-a-minute key refresh before the request goes out, as before, and takes it back when the fetcher throws the new `FetchRefused` (the inbox's admission throws it for a refused lookup and for a lookup over its eight fetches); any other failure still spends the minute. Tests at the verifier and through `receiveInbound`: a refused lookup from one address leaves the actor's minute for the next client (4ef3a42).
- `handleFederationRequest(request, { peer })` passes `peer` to `receiveInbound(request, { peer })`; web's bridge computes it for an inbox POST with `clientIp` (the trusted-proxy rule, then the connection's peer from `getRequestIP`), so the admission never depends on `request.ip`. Tests: the bridge hands `203.0.113.1` for `X-Forwarded-For: 10.9.9.9, 203.0.113.1` under `PEBLISH_TRUSTED_PROXY=traefik`, the header of Cloudflare for `cloudflare` and the peer for none; `handleFederationRequest` counts a spent address and a forwarded one behind Traefik (f1bea5f). A `PEBLISH_TRUSTED_PROXY` that does not parse throws in `clientIp` (it fails every sign-in); the inbox is not allowed an unexpected 5xx, so the bridge logs it and federation falls back to its own reading of the request (adc7ada).
- `e2e/comments/comments.spec.ts` "a reply on a page the router opened shows on that page" waits for the "More comments" link to name `sort=old` before following it (0301e06; see the verification below).
- The federation README's inbound section is rewritten (the four budgets, the address, the atomic admission, the yield and the per-claim allowance, the claim assertion per member, the mirror deferrals, the `keys: false` store), the README's ownership rows name `e2e/composer/viewer.spec.ts`, `inbound/client.ts`, `client.test.ts`, `moderators/refresh.test.ts`, the bridge's peer and `FetchRefused`, and `deploy/README.md` says the proxy setting also feeds the inbox's lookup limits.

Statements the fixes made wrong: "an announced Update(Group) keeps the stored key" (batch B, FED-B 4) was done by reading the held key and writing it back, which a rotation between the read and the write could undo; it is now `keys: false`, which never touches key rows. "Key fetches are limited per host and in total" (the old README) is replaced by discovery and refresh budgets per address, host and in all. The wave 3 lab's intake numbers (300 and 1,200 requests a minute, 8 and 32 MiB pending) now come with the lookup numbers above.

Left open, recorded for Andrew (the workflow's P3 that no lane fixed, and Codex's P3 11): fed-a, the key id fetched twice when it is the actor URL; fed-b, a gone account's Delete is answered 202 only after a throttled key fetch, a joined in-flight resolution carries another row's budgeted fetcher and lease (ClaimLost propagates), a batch of 55 or more members that each skip after a fetch can fail after eight attempts (skipped members are not remembered between claims); rem, bulk removal in `prepare` without lease renewal, the dormancy probe is consumed when it is asked for, not when the delivery completes (needs a hook in fed-a's `delivery/run.ts`), a remote object soft-deleted before its first recheck and then restored is not rechecked again, an optional partial index on `inbox_raw (received_at) where state = 'skipped'`; b1, a future-dated peer `updated` freezes a post; d, `comment.restored` is not consumed by delivery; c1, an SVG-typed link keeps its full remote address in the feed page data, and the cursor refuses a post at or before the epoch; composer, an edit infers the post type from a withheld url when gated, and a hidden tab learns of a viewer change only when it becomes visible; ui, the viewer sync ignores session expiry and always-visible windows, the router location keeps `#pb-side` after the drawer adopts it, and `/kit` has 1.2 kB of headroom. The yield refunds an attempt by decrementing the claim generation, so a worker whose lease ran out can match it again until the next lease; its settlement is a complete pass of its own, so nothing conflicts. The fixed rates throttle a signer above five requests a second and an instance above twenty (averaged over a minute); there is no measured peer rate for lemmy.world, and the lookup and intake limits are per process.

Verification on lane root with the four merged (head at the time of the last run is the commit before the documentation commits):

- `pnpm install --frozen-lockfile` is up to date (no lockfile change). `pnpm check` is green: 157 test files (155 passed, 2 skipped), 2,089 tests passed and 3 skipped (FIT's opt-in build and archive tests, C1's opt-in performance test), no boundary violations (693 modules), oxlint and Prettier clean. `pnpm db:drift`: none, with no migration added.
- `PEBLISH_UI_KIT=1 pnpm e2e`: the first run was 211 passed and 1 failed, then stopped (`comments.spec.ts` "a reply on a page the router opened shows on that page", four failures in six repeats alone): the test clicked "More comments" right after "Old", while the default view and its link to the default sort's next page are still shown until the Old fetch arrives, so it followed `sort=hot`. D's lane had passed it by timing. The test now waits for the link to name `sort=old` before following it (a test race; the product behaves as D documented: the address changes first and the default view stays until the fetch arrives). After that: 218 passed, 1 skipped. Payload is unchanged: 62.8 kB of script on the five feed pages; 126.3 kB on the auth, invite, settings, admin and signed-out `/submit` pages; 127.3 kB on `/post/<id>` and the permalink; 129.4 kB on `/submit` signed in (the sheet adds 105.8 kB lazily, of 200); 168.8 kB on `/kit`, 1.2 kB of room. CSS 60.4 of 65 kB, fonts 105.6 kB, 259.2 of 270 on `/kit`.
- `docker build` (tagged `peblish:w2-batch-b-fix3`), then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after): the disagreeing command exits 64, migrate (seven migrations applied, `object_rechecks` and the three batch B indexes present), the first admin, the worker starts and stops on SIGTERM, web `/healthz`, `/readyz` and the healthcheck, uid 1000.

## Wave 3 integrated (2026-11-10)

Branch `mvp-w3`, from `w3-groundwork` plus the outbox worker test fix (df6f74d). Nine lanes merged with `git merge --no-ff`, after root's clock branch and `origin/main`; their notes are kept outside the repository in `/Users/admin/.agents/plans/feddit/lane-notes/wave-3/<lane>.md`, and `LANE-NOTES.md` was dropped from the tree in each merge. LAB (`mvp-w3-lab`) is not merged: root merges it later.

| Lane        | What it brought                                                                                                                                                                    | Head    | Merge   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| clock       | root's fixes: the backfill tests on a relative clock, the sidebar's counted links named by their text, `editable()` keeping a response's status                                    | 360984f | 6b39deb |
| origin/main | PR #4 (spike folder only)                                                                                                                                                          | 69043ad | 9a2c015 |
| FED-C       | Mastodon-like withdrawal (`Undo(Announce)`, author `Delete`), direct `Update(Page)`, outbound mentions, `delivery.enabled`, the outbound site-ban `Block`, the served mention `cc` | a578116 | a8a1b17 |
| E1          | person, community and instance blocks and their feed predicate, the profile page and tabs, Edit profile                                                                            | 5e695aa | 417d3f2 |
| E2          | `notifications`, the inbox with replies, mentions, removal and ban notices, the unread badge                                                                                       | 1d8b87e | 8722f7d |
| COMM        | the community page, the community form, the NSFW gate page and Hide NSFW                                                                                                           | 2a14817 | f7fbc86 |
| MODF        | site bans (in and out of the principal), peer controls, the modlog feed, remove, restore and ban flows, the Bans and Peers tabs, the moderate slots                                | cadc6f6 | 6205d2d |
| REP         | eleven report categories, `/report` and its dialog, the queue at `/admin/reports`, inbound and outbound Flag                                                                       | e7b006d | 49ebad4 |
| DISC        | the community directory and `/resolve`                                                                                                                                             | 1d18f0a | 66d8786 |
| ADM         | the Settings and Pages tabs, the kill switches, the `pages` CMS seeded from `content/legal`, the public `/<slug>` pages                                                            | 3d8eeed | 0036755 |
| SAFE        | upload scanning (local hash list, Arachnid adapter), the evidence log and purge, the admin Media tab, `/media/<id>`                                                                | 6be9f49 | 8482c89 |

Conflicts: only `e2e/payload/routes.ts` (E2, MODF, REP, ADM, SAFE merges; every lane's entries kept, the seed helpers of COMM and REP both kept) and `LANE-NOTES.md` (dropped). No i18n, README or generated file conflicted; `pnpm gen` after the merges changed nothing. `rm -rf node_modules && pnpm install` left the lockfile as it was (no lane added a dependency).

Migrations, generated once after the merges:

- `0008_wave_3` (drizzle-kit): `person_blocks` (with `person_blocks_not_self`), `community_blocks`, `instance_blocks` (E1); `notifications` (E2, no foreign key on `modlog_id`); the `reports` delta (`number` identity, `audience`, `escalated_by`, `escalated_at`, `resolution`, `resolution_note`, `modlog_id`, indexes `reports_queue` and partial unique `reports_open_once`, checks `reports_audience` and `reports_resolution`; REP); `site_bans`, `peer_controls` (MODF); `pages`, `page_revisions` (ADM); `media_blocklist`, `media_scans`, `media_evidence`, `media_evidence_log` (SAFE); and two indexes added in schema code: `comments_author_published` on comments `(author_id, published_at desc)` (E1's profile lists) and the partial `media_purge` on media `(scan_state) where storage_key is not null and scan_state in ('blocked', 'failed')` (SAFE's purge pass). Compared statement by statement with the six lanes' scratch SQL: 59 statements, every lane statement present, the two indexes the only additions.
- `0009_wave_3_guards` (custom, hand-written): `media_evidence_log` and `page_revisions` refuse update, delete and truncate with the 0001 function `peblish_append_only()`, as the deletion ledger does. `truncateAll` lists both truncate guards; `seed-adm.ts` suspends the row guard while it empties the revisions on a lane database. `db/spine.test.ts` checks both tables and the trigger list.
- `pnpm db:drift`: none. `peblish_root` and `peblish_root_test` were dropped and recreated on the ten migrations.

Integration commits, after the merges:

| Commit  | Change                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| f7bac97 | Migration `0008_wave_3`, the two indexes in schema code                                                                                                                                                                                          |
| 4987d36 | Migration `0009_wave_3_guards`, `truncateGuards`, the spine test, the ADM seed's reset                                                                                                                                                           |
| 774ee7b | The payload budget's self-test names `/nonexistent/` as its unaccounted route (`/communities/` is budgeted now)                                                                                                                                  |
| 21e0c4b | `MEDIASCAN_LOCAL_ONLY: '1'` in Playwright's `webServer.env` and the CI Playwright step                                                                                                                                                           |
| c5e1ef3 | The serial Playwright project (below); `PEBLISH_E2E_FLIP_ALL` and `E2E_PAUSE_SWITCH` are gone                                                                                                                                                    |
| f1ccfd1 | COMM's `varyByAccept()` workaround removed; the profile spec asserts the 404 of an unknown `/u/<x>` (COMM's already did for `/c/<x>`)                                                                                                            |
| 1099e29 | E2's and REP's sidebar axe exclusions removed; the auth flow accepts a count after the You links                                                                                                                                                 |
| dccab01 | The Markdown editor's toolbar buttons are at least 28 px high; E1's axe exclusion on the edit page removed                                                                                                                                       |
| 14f2ca3 | `resolve/blocked.ts` reads MODF's peer controls (`instanceBlocked`, and a new `blockedDomains` in `peers/gate.ts`)                                                                                                                               |
| 422d47f | The directory spec follows the resolve redirects: a held remote community and person open on `/c/<name>@<host>` and `/u/<name>@<host>` with a 200                                                                                                |
| 33d803a | The directory leaves out communities with `discoverable` false (COMM's request to DISC)                                                                                                                                                          |
| 5e4b940 | Admins see "New community" in the directory (COMM's request to DISC)                                                                                                                                                                             |
| 53360e1 | The inbox spec finds the unread count in the page (the sidebar badge now says "11 unread" too)                                                                                                                                                   |
| dadbcda | A person sees the private modlog entries about them (a ban of them, a removal of their post or comment); `/modlog?entry=<id>` shows one entry, and the inbox links each statement of reasons there (E2 linked `/modlog/<id>`, which has no page) |
| a76e2b0 | deploy/README.md: SAFE's six scanner variables, no variable turns uploads on, the two worker jobs                                                                                                                                                |
| 92135db | `.dockerignore` says why `content/` stays in the build context                                                                                                                                                                                   |
| c434786 | `registrationSettings` reads its rows in code point key order, as the settings writer locks them                                                                                                                                                 |
| 3b8b34c | `spikes/README.md` points at `phase-0.complete.md`                                                                                                                                                                                               |
| c11ddcd | README: how the serial e2e project runs                                                                                                                                                                                                          |
| 37f7ef3 | The profile edit page links `composer.css` (the editor was unstyled there, which is what failed axe `target-size`)                                                                                                                               |
| 7a10649 | The auth flow's You link pattern allows the space before the badge                                                                                                                                                                               |
| 367de0a | The `/kit` gallery gets its own 180 kB JavaScript ceiling (it measured 170.5 kB once the vendor chunks split around the new pages; product pages keep 170 kB and measure 126.6 kB)                                                               |
| 4378e9c | `seed-adm.ts` tolerates the other ADM spec creating `adm_member` first                                                                                                                                                                           |
| 7e7a6cf | `db/migrate.test.ts` cases get 30 s (they migrate whole databases, ten migrations now)                                                                                                                                                           |
| (last)  | This section                                                                                                                                                                                                                                     |

The serial project: a spec named `*.serial.spec.ts` runs in the Playwright project `serial` (one worker, `dependencies: ['chromium']`) after the parallel one, which ignores those files. In it: ADM's kill switch cases and the inbox pause (`e2e/admin/switches.serial.spec.ts`, its own admin `adm_switch_admin`), SAFE's remote-media pause case (`e2e/mediascan/pause-switch.serial.spec.ts`), B2's `e2e/media/proxy.serial.spec.ts`, the composer's uploads spec (`e2e/composer/uploads.serial.spec.ts`: it flips `uploads.enabled`, which ADM's Settings row reads) and the composer's "what Preview shows is what is published" cases (`e2e/composer/preview.serial.spec.ts`). Playwright skips the serial project when the parallel one fails; `pnpm e2e --project serial --no-deps` runs it alone.

Site-ban contract, checked on both sides: MODF's `banFromSite` emits one `mod.ban` with `communityId: null`, `banned`, `removeContent`, `targetActorId` and `targetApId`; FED-C's `onSiteBan` reads exactly those (types and code; no test drives both together).

Verification on lane root (port 18399):

- `rm -rf node_modules && pnpm install`: lockfile unchanged.
- `pnpm install --frozen-lockfile`: up to date. `pnpm check` is green: 218 test files passed and 4 skipped, 2,508 tests passed and 7 skipped, no boundary violations (1,015 modules), oxlint and Prettier clean. The two full runs before 7e7a6cf each had one failure, `db/migrate.test.ts` past its 5 s default (load average 10 to 14; 1.6 to 3 s alone, three of three).
- `pnpm build && pnpm e2e`: 353 passed and 1 skipped (the `/kit` 404 case that needs a server without `PEBLISH_UI_KIT`); the serial project's 15 cases among them. The first full run had four failures, each fixed above (37f7ef3, 7a10649, 367de0a, 4378e9c). Payload: product pages 126.6 kB script of 170 (`/submit` signed in 130.7), Mux CSS 60.4 of 65, fonts 259.2 of 270 on `/kit`.
- `docker build -t peblish:w3 .`, then `scripts/image-smoke.sh` against a throwaway `peblish_root_image` (dropped after), as CI's image job: the disagreeing command is refused, migrate applies the ten migrations, the first admin, the worker starts and stops, web answers `/healthz` and `/readyz` as uid 1000.
- `PEBLISH_FEED_PERF=1` `feeds/perf.test.ts`: fails on three of four runs at load average 11 to 21 (one run passed). It is a regression, not load: "follows 130 / subscribed" on New, Old and Top (year, all) measures p50 35 to 55 ms (p95 up to 70 ms; wave 2 C1 measured p95 4 to 5 ms). The plan reads every post of the 130 followed communities (`posts_community_published` per community, 43,793 rows, then a top-N sort) instead of walking `posts_published`: the planner estimates 20 rows, because E1's `blocks` and MODF's `blocked-peers` feed predicates add five `NOT IN (sub-select)` clauses it estimates at a flat selectivity each. With both predicates off the same rows measure 3.4 ms on `posts_published`; with either one alone they stay slow. A rewrite of both as correlated `NOT EXISTS` was tried and reverted (it fixed those rows but moved the cost to Top month and the Hot rows). Left for the review.

Left open (with the reason):

- The feed perf regression above: it needs a design choice across E1's and MODF's predicates (or the feed query), and its own perf pass.
- Cross-lane requests that add UI states and copy without a mock: the community page's notice and Unblock for a community the viewer blocked (E1 to COMM), prefilling the People tab from `/settings/blocks?person=<handle>` (REP to E1), a Report link for signed-out visitors (REP's request 6), DISC hiding or marking blocked communities with `blockedAmong` (E1's "may").
- Not built, as the brief says: FED-C's site-ban withdrawal edge case and E2's report outcome notices (`report.resolved`); the review decides.
- Optional or not code: E2's `notification` throttle scope (optional), the bare `@name` launch gap line in `phase-1.md`, the cutover runbook items (`site.name` "Feddit", operator settings, publishing the pages, starting the notifications consumer at `'now'` if the outbox holds removal or ban history), German copy review of `mediascan.json`, Andrew's Cloudflare Cache Rule and the Arachnid auth scheme.
- Other timing tests (`outbox/worker.test.ts` and the ones the lane notes name) can still time out on the busy shared Postgres; none did in the final run.
- LAB's branch is not merged.

Housekeeping: no push; the lane worktrees, branches and databases stay; the `peblish:w3` image tag stays.
