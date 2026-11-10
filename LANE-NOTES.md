# FR4-TOOLS lane notes: cutover tooling fixes (TN1 to TN7)

Worktree `/Users/admin/Projects/feddit-mvp-w4-fr-tools`, branch `mvp-w4-fr-tools` from tag
`w4-fixes` (0f091d7), `lane.sh` name `b06` (port 18323). Brief: `briefs/wave-4/review-2-fixes.md`,
findings: `review-2-findings.md`, "Cutover tooling".

| Item | Commit           | Proving test                                                                                                                                                                                                                                                               | Schema change                                                   |
| ---- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| TN1  | 179b2dd, 229e587 | `drill.test.ts`: "the drill restores into a new database of its own and drops only that one" (an occupied `<db>_drill` with an open session survives), "a restore refuses an existing database and a name Postgres would cut; a drop refuses a database it did not create" | none                                                            |
| TN2  | 25a623e          | `drill.test.ts`: "a restore re-applies a media block whole" (both hashes listed again, both clean copies quarantined with their incidents and `media.quarantined` events, also for a blocked row newer than the backup; idempotent). Fails with the hash replay disabled   | none (hash and category go in the ledger row's `details` jsonb) |
| TN3  | f35213a          | runbook only (`deploy/cutover.md` step 7 items 3, 4, 7 and step 9)                                                                                                                                                                                                         | none                                                            |
| TN4  | d82e632          | runbook only (step 6 item 1, rollback); the Caddyfile change was validated and served with `caddy:2.10-alpine` against a scratch copy of the archived Caddyfile                                                                                                            | none                                                            |
| TN5  | bb54acd          | `errors.test.ts` (3 tests): bad JSON in the bundle, a key file or a ledger export; wrong shapes; the CLI's `describe` on its own error, a plain error, a real Postgres error and a Node system error                                                                       | none                                                            |
| TN6  | ab8427c          | `verify.test.ts`: "an actor the bundle expects that is missing, a missing key row and a key without its private half each fail verify", "verify fails when it finds nothing to check, and a key that is not routed fails"                                                  | none                                                            |
| TN7  | 5ba72a1          | `import.test.ts`: "turns the federation switch off first, in its own transaction, so a refused import leaves it off too"                                                                                                                                                   | none                                                            |

## 1. What landed

- **TN1, the drill's database.** `restore` creates the target itself and refuses one that exists
  (checked first, and `42P04` from a concurrent create), refuses a name over 63 bytes (and any name
  not `[a-z0-9_]`), marks the database with a comment holding a random marker, and drops its own
  half-restored database when `pg_restore` fails. `runDrill` (moved from `cli.ts` into `drill.ts`)
  restores into `drill_<yyyymmddThhmmss>_<6 hex>` (28 bytes, independent of the source name) and
  drops only a database whose comment is its marker; `WITH (FORCE)` is used only there. The old
  `dropDatabase` (`drop database if exists ... with (force)` on any name) is gone.
- **TN2, a media block replayed whole.** `blockMedia` (`packages/core/src/mediascan/block.ts`) now
  writes `sha256` and `category` into its `media.blocked` ledger row and hands the hash half to a
  new exported `listBlockedHash` (hash lock, list entry on conflict do nothing, every clean,
  undeleted copy quarantined under the entry). `categoryOf` is exported. The drill's replay runs
  in a drizzle transaction on the restored database with core's `outboxEmitter`, sets the row
  blocked as before, then calls `listBlockedHash`, whether or not the blocked row is in the backup.
  The replay's report gains `quarantinedCopies`.
- **TN3, runbook step 7.** The Cloudflare-only firewall is made concrete (an ipset of Cloudflare's
  ranges, `DOCKER-USER` rules matching new inbound connections to 80 and 443 on the public
  interface, IPv4 and IPv6, read back, persisted). A temporary operator path adds Andrew's current
  address for the sign-in and the pretest; the text says what `PEBLISH_TRUSTED_PROXY=cloudflare`
  does with a direct request (no `CF-Connecting-IP`, so the peer is used, which behind Easypanel is
  Traefik: throttles and the session list then key on Traefik's address for every direct request,
  and a direct client could set the header itself). The path closes before the origin switch with
  a check that a direct request gets no connection, repeated before opening (step 9).
- **TN4, runbook step 6.** Before stopping PieFed the box's Caddy replaces its `feddit.com` block
  with `header Retry-After 3600`, `header Cache-Control no-store` and `respond ... 503`: the exact
  diff, how to build it from the box's current file (and check it is the archived one), validate,
  install and `systemctl reload caddy`, a `curl` check through Cloudflare for GET and POST paths,
  the same check again after PieFed stops, and the rollback (start PieFed first, then restore
  `Caddyfile.piefed`). It stays until the origin switch.
- **TN5, error output.** New `tools/cutover/src/errors.ts`: `CutoverError` (the tool's own class;
  `ImportRefused` and the CLI's `Usage` extend it, and the tool's other throws use it),
  `readJsonFile` (bad JSON names a line and column when V8 gives one, a mismatch names paths), and
  `describe`, which the CLI uses: a `CutoverError`'s message, a Postgres error's code and
  constraint, table and column names, a Node system error's code, call and path, otherwise a fixed
  phrase. `readBundle`, `readLedgerExport` and `crossCheckKeyFiles` (now with a `KeyFile` schema)
  read through it. A `pg_dump` or `pg_restore` failure shows only the start of its first error
  line.
- **TN6, verify.** Actors are read with a left join to their key; the report gains `problems`
  (`actor missing` for a bundle actor not here, `key missing`, `private key missing`) and `ok`
  (at least one key checked, no problem, every key passes). `keyPasses` includes `routed`, and
  `matchesBundle` compares the key id as well as the key. The CLI prints the problems and exits on
  `ok`.
- **TN7, import.** `federationOff` writes `delivery.enabled = false` in its own `tx()` before the
  bundle is even checked; the report gains `federation: { deliveryEnabled: false, wasOn }`.
- Runbook lines for TN1, TN2, TN5, TN6 and TN7 in the commits of those items.

## 2. Commits

| Commit  | Subject                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| 179b2dd | Restore the drill into a new database of its own and drop only that one                |
| 229e587 | Say in the runbook that restore and drill only ever create a new database              |
| 25a623e | Re-apply a media block whole after a restore                                           |
| d82e632 | Put a 503 maintenance responder in front of PieFed before stopping it                  |
| f35213a | Give the production pretest a temporary operator path through the firewall             |
| bb54acd | Print the cutover tool's own messages only, never file content                         |
| ab8427c | Fail verify on a missing actor, key or private key, on nothing checked, and on routing |
| 5ba72a1 | Turn the federation switch off at the start of import                                  |
| (this)  | Add the FR4-TOOLS lane notes                                                           |

## 3. Verification

Baseline `pnpm exec vitest run --project tools` on `w4-fixes`: 37 passed, 4 skipped. The machine
ran three other lanes' checks throughout (load average 37 to 54), so several full runs hit load
timeouts in files this lane does not touch; each was rerun alone, green, before the commit:

| Commit  | `pnpm check`                                                                                                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 179b2dd | 2,670 passed, 9 skipped, 3 failed in `core/src/comments/mutations.test.ts` (a 5 s timeout, then a truncate deadlock); that file alone: 18 passed                                                                                                                                                         |
| 229e587 | runbook only: `prettier --check deploy/cutover.md` (the code was the 179b2dd tree)                                                                                                                                                                                                                       |
| 25a623e | 2,671 passed, 9 skipped, 3 failed in `federation` `inbound/pipeline.test.ts`, `inbound/receive.test.ts`, `nodeinfo/client.test.ts`; the same two of them failed with my changes stashed (load); the three files alone on retry: 59 passed                                                                |
| d82e632 | runbook only: `prettier --check deploy/cutover.md`                                                                                                                                                                                                                                                       |
| f35213a | runbook only: `prettier --check deploy/cutover.md`                                                                                                                                                                                                                                                       |
| bb54acd | first run stopped at lint (an unused import, fixed); second run 2,673 passed, 10 skipped, 4 failed in `core/src/db/migrate.test.ts`, `core/src/reports/read.test.ts` (50.4 ms on a 50 ms budget), `federation` `receive.test.ts`, `nodeinfo/client.test.ts`; alone: core 12 passed, federation 27 passed |
| ab8427c | 2,674 passed, 10 skipped, 5 failed in `core/src/comments/mutations.test.ts`, `core/src/db/migrate.test.ts`, `core/src/reports/read.test.ts`; those three files alone: 30 passed                                                                                                                          |
| 5ba72a1 | green: 2,680 passed, 10 skipped                                                                                                                                                                                                                                                                          |

- `pnpm build && pnpm e2e` at the end (block.ts is under `packages/`): green, parallel run 324 passed and 1 skipped, serial run 33 passed.
- Opt-in, against the local archive: `CUTOVER_ARCHIVE_DIR=/Users/admin/Projects/feddit-archive/2026-11-08 pnpm exec vitest run --project tools tools/cutover/src/archive.test.ts -t "key files"`: 1 passed (the three key files fit the `KeyFile` shape; the test reports counts only). The archive database tests (`CUTOVER_ARCHIVE_DB_URL`) were not rerun: `piefed_archive` is dropped and nothing they cover changed.
- TN2's test was run once with the hash replay disabled: it failed on the report and states, as expected.
- TN4: the maintenance Caddyfile was built with the runbook's own `perl` line from a scratch copy of the archived Caddyfile, validated (`caddy validate`) and served by `caddy:2.10-alpine` locally: `POST /inbox` and an ActivityPub `GET` both answered `503`, `Retry-After: 3600`, `Cache-Control: no-store`. No live server was contacted.

## 4. Decisions and deviations

1. **TN2 needs no schema change.** The ledger row's `details` (jsonb) carries `sha256` and
   `category`; no scratch `0013`.
2. **TN2, a row written before this change** (no `sha256` in `details`) falls back to the restored
   media row's hash and the category of its evidence (`details.evidenceId`), else `other`.
   Production has no such rows (its ledger starts at the cutover).
3. **TN2, the copies' incidents start at the replay**, not at the original block, so an admin gets
   the whole undecided window for them again before the expiry can block them. The list entry's
   `added_by` is the confirming admin when that actor is in the backup, else null.
4. **TN2 replays through core's block path** (`listBlockedHash`, `quarantine`, the outbox emitter),
   but sets the blocked row itself with SQL, as before: `blockMedia` needs the row quarantined
   with its evidence, and must not write a second ledger row.
5. **TN1, restore drops what it created when `pg_restore` fails**, so a retry into the same name
   works. `--keep` leaves the drill's database; the runbook says to drop it by hand.
6. **TN3 makes the step 7 firewall concrete** (it said "Easypanel or host firewall"): ipset and
   `DOCKER-USER`, with a check that Traefik's ports are Docker-published and the `INPUT` variant if
   not. It is written from Docker's documented behaviour, not run on the production host; the
   no-connection checks are what prove it there.
7. **TN3 closes the operator path before the origin switch**, earlier than "before opening", and
   step 9 repeats the check, so the hosts file and the extra address never outlive the pretest.
8. **TN4 assumes the box runs the Debian-packaged Caddy** (`/etc/caddy/Caddyfile`, systemd), as the
   archived file (the package's default template plus the `feddit.com` block) and the Phase 0
   notes ("Host Caddy terminates TLS on 80 and 443") suggest; the runbook checks this first and
   checks the box's file equals the archived one before changing it.
9. **TN5, ArkType's `expected` quotes the value for a union** ("must be "admin" or "user" (was
   ...)"), so the old CLI path printed values too. Only the schema's `description` is printed now,
   and a path without one says "has the wrong type or value" (booleans are unions, so they read
   that way).
10. **Deviation, TN7 writes `site_settings` directly**, as the runbook's SQL does, inside core's
    `tx()`: `settings.update` lets only an admin with two-factor through, and none can sign in
    yet. So no `settings.update` modlog row and no `settings.updated` event are written. See
    request 1.
11. **TN7 runs before the bundle is checked**, so even a malformed bundle or a host refusal leaves
    the switch off. Running `import` against a live database turns its federation off; the
    runbook runs it only before step 8.
12. **TN6, without `--bundle`** verify cannot know which actors are expected; it still fails on a
    key row or private key missing and on an empty result.
13. **Deviation, port.** The local Caddy test bound host port 18399 (root's) for about a minute
    instead of 18323. The container was stopped at once; nothing else used it.

## 5. Requests to root

1. **Let `settings.update` accept the system import principal for `delivery.enabled` off**
   (`packages/core/src/authz/actions/settings.ts`), so the import can call
   `updateSettings.within` and write the private modlog row and `settings.updated` like any other
   change. Why: decision 10.
2. **Ledger the hand-made list changes.** `addBlockedHash` and `removeBlockedHash`
   (`mediascan/list.ts`, outside this write set) write no ledger row, so a restore loses a hash an
   admin listed after the backup (its clean copies are public again) and re-lists, through a
   replayed block, a hash removed after it. Same shape as TN2: a `media_blocklist` ledger row
   (`subject_kind` would need a value for a list entry, or `media` with the entry in `details`)
   and a drill rule.
3. **TLS on the new origin before the switch** (new, found writing TN3): a Let's Encrypt HTTP
   challenge for feddit.com cannot pass while Cloudflare still sends feddit.com to the box. Choose a
   Cloudflare Origin CA certificate in Easypanel or a DNS challenge, and make it a go or no-go
   item. The runbook says this in step 7.2; the choice is root's.

## 6. Requests to other lanes, through root

None.

## 7. Dependencies added

None. `tools/cutover` now imports `drizzle-orm/postgres-js` (already a dependency, 0.45.4).

## 8. For later lanes

- `runDrill(url, dir, { keep })` and `restore(file, url)` return or use an `OwnDatabase`; drop only
  with `dropOwnDatabase(own)`. Nothing in the tool drops a database it did not create.
- A new `deletion_ledger` reason still needs a rule in `drill.ts` (`apply`). A replay rule that
  needs core's code runs in the replay's drizzle transaction (`ReplayTx`, with an outbox emit).
- `listBlockedHash(t, { action, sha256, category, by, now })` is the hash half of a block, for any
  caller that blocks by hash.
- Throw `CutoverError` for anything an operator should read; any other error is printed as codes
  only. Read operator files with `readJsonFile`.
- `verify`'s exit follows `report.ok`.

## 9. Left open and risks

- Request 2 (hand-made list changes are not in the ledger).
- After a restore, the blocked row's evidence keeps its state from the backup (for example
  `open`); `confirmMatch` and the expiry both refuse a blocked row, so it shows only as a stale
  open incident.
- The firewall commands (TN3) and the Caddy change (TN4) are untested on the real hosts by design;
  their checks are in the runbook.
- Request 3 (origin certificate) blocks the switch until decided.
