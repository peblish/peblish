# B06 lane notes: cutover tooling and rehearsal (step 1)

Worktree `/Users/admin/Projects/feddit-mvp-w4-b06`, branch `mvp-w4-b06` from `origin/main`
(29fbfec). Step 2 (the Easypanel rehearsal) waits for root.

## 1. What landed

| Deliverable (brief item)     | Where                                                                                  | Proof                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `inventory`               | `tools/cutover/src/archive.ts` (`inventory`), `cli.ts`                                 | `archive.test.ts` (opt-in, `CUTOVER_ARCHIVE_DB_URL`), run on the archive (section "Inventory")                                                                 |
| 1. `export`                  | `archive.ts` (`exportBundle`, `crossCheckKeyFiles`), `bundle.ts`                       | `archive.test.ts` (opt-in), `bundle.test.ts` (mode 600, no overwrite, never in the repository); key files matched 5 of 5                                       |
| 1. `import`                  | `tools/cutover/src/import.ts`                                                          | `import.test.ts`: ids, inboxes, keys, owners, follows accepted, idempotent, host refusal and rehearsal, minted instance actor refused, key replacement refused |
| 1. `verify`                  | `tools/cutover/src/verify.ts`                                                          | `verify.test.ts`: sign and verify per key, served document, bundle match, follow targets; a wrong private key fails                                            |
| 2. Password decision         | decision 1 below; `import.ts`                                                          | `import.test.ts`: an imported account signs in after a password reset                                                                                          |
| 3. Backup and restore drill  | `tools/cutover/src/drill.ts`, `cli.ts` (`backup`, `ledger-export`, `restore`, `drill`) | `drill.test.ts` on the lane test database: deletions after the backup come back in ledger order; an unknown reason stops it                                    |
| 4. Runbook                   | `deploy/cutover.md`                                                                    | steps 3 to 10, go or no-go, rollback, soak                                                                                                                     |
| 5. `feddit-admin` name check | `tools/cutover/src/lab/name-check.ts`                                                  | lab run, section "Lemmy name check"                                                                                                                            |
| 6. Local rehearsal           | commands in `deploy/cutover.md` step 4                                                 | section "Local rehearsal"                                                                                                                                      |

### Inventory (cutover step 3), 2026-11-08 archive, PieFed schema `7c5a293ed40c`

- Local accounts 2, local communities 2.
- `announcements`: 1 member, local (its owner, `feddit-admin`). PieFed has it `local_only`, so it never federated.
- `microblogs`: 0 members.
- Chat messages 0, conversations 0, local posts 0, local comments 0.
- `feddit-admin` follows 131: 130 remote communities on 28 instances (129 Lemmy, 1 PieFed) plus the local `announcements`.
- Accepted state: all 131 are PieFed memberships, which PieFed writes when the Accept arrives (at once for a local community); all 130 remote ones carry the Follow id PieFed sent; 0 join requests wait unanswered; 0 banned. PieFed kept no activity log, so the Accepts cannot be re-read: the rehearsal and week one sample them (decision 3).
- 9 of the 130 are on instances PieFed marks dormant or gone.
- The other account follows nothing.

### Local rehearsal (2026-11-10)

Fresh database `peblish_b06_rehearsal`, migrated without `PUBLIC_ORIGIN`, then the real bundle with
`--rehearsal-host rehearsal.peblish.test`:

- Import 2.2 s: instance actor 1, users 2, communities 2, remote communities 130, follows 131. A second run: all present, nothing written. Without `--rehearsal-host`, and with a wrong one, refused.
- `verify`: 5 of 5 keys pass (pair, signature, served document, same key as the bundle); 131 follows accepted, 0 pending, 0 held, 28 hosts. `/actor` is served by id but not routed (request 1).
- Migrate run again with `PUBLIC_ORIGIN` set (as every later deploy runs it): keeps the imported instance actor and its key.
- `drill`: backup, ledger export, restore into `_drill`, re-apply, counts identical (instances 29, actors 135, keys 135, users 2, follows 131, outbox 265); files mode 600. The rehearsal has no ledger rows; `drill.test.ts` covers the re-apply.
- Host-header pretest of the built server on port 18323: `/u/feddit-admin`, `/u/Andrew` (and `/u/andrew`), `/c/announcements`, `/c/microblogs` answer their documents with the imported key ids; WebFinger answers for all three; NodeInfo 2.1 has usage (users 2) and nodeName "Feddit (Beta)". `GET /actor` answers 406 and `POST /actor/inbox` 404.

### Lemmy name check (federation lab, Lemmy 0.19.21)

A local peblish account `feddit-admin`, written as the import writes one, against `!lab@lemmy.lab.test`:

- Follow: accepted.
- Post: on Lemmy, credited to `https://peblish.lab.test/u/feddit-admin`.
- A Lemmy reply mentioning `@feddit-admin@peblish.lab.test`: arrived with a Mention tag naming the actor.
- Lemmy resolves the actor URL and the handle `@feddit-admin@peblish.lab.test`, and `GET /api/v3/user?username=feddit-admin@peblish.lab.test` returns it.

So Lemmy 0.19.21 resolves the hyphenated name and accepts its activities; no fallback to `Andrew`
is needed. The lab was reset afterwards (no containers, no lab volumes, `lab/data` removed); the
images stay. Also confirmed in the lab: PieFed 1.8.11's instance actor is `/actor` with inbox
`/actor/inbox`, outbox `/actor/outbox`, shared inbox `/inbox`, key `/actor#main-key`.

## 2. Commits

| Commit  | Subject                                                                   |
| ------- | ------------------------------------------------------------------------- |
| 0308ec4 | Add the cutover tool package to the workspace                             |
| e10c6db | Add the cutover bundle and the inventory and export of the PieFed archive |
| c8584c1 | Add the cutover import                                                    |
| 157e20d | Add the cutover key verification                                          |
| 01345b1 | Add the backup and restore drill that re-applies the deletion ledger      |
| 1b59c05 | Add the cutover command line                                              |
| 6db8744 | Add the feddit-admin name check for the federation lab                    |
| 46a0c73 | Add the feddit.com cutover runbook                                        |
| (this)  | Add the B06 lane notes                                                    |

## 3. Verification

- `pnpm check` on every commit, each green (about 5.5 minutes each): 0308ec4 2,595 passed, 7 skipped; e10c6db 2,596 and 9; c8584c1 2,601 and 9; 157e20d 2,603 and 9; 01345b1, 1b59c05, 6db8744 and 46a0c73 2,605 and 9 (main: 2,595). The first run of the drill commit failed on a load timeout: its `afterAll` dropped the restored database within vitest's 10 s hook limit, and `DROP DATABASE` forces a checkpoint that takes longer while the other test projects write. I amended that commit (not yet pushed) to give the hooks 60 s and the tests 120 s and 30 s, replayed the three later commits, and reran all four: green. The notes commit was checked as well (below).
- Opt-in: `CUTOVER_ARCHIVE_DB_URL=postgres://peblish:peblish@127.0.0.1:18432/piefed_archive pnpm exec vitest run --project tools tools/cutover/src/archive.test.ts`: 2 passed.
- `drill.test.ts` ran locally (pg_dump and pg_restore 17.11); it skips in CI (request 2).
- No e2e run: nothing in `packages/web` or any page changed.
- Lab: `make reset up seed` (3 min 44 s), then `docker compose run --rm runner node ../cutover/src/lab/name-check.ts` (10 s), then `make reset`.

## 4. Decisions and deviations

1. **Passwords are not carried.** PieFed's hashes are werkzeug `pbkdf2:sha256:600000`. better-auth 1.7.18 verifies only its own scrypt format unless core's `identity/auth.ts` replaces `emailAndPassword.password.verify` with one that also reads werkzeug PBKDF2 (and rehashes on sign-in). That is lane A's security-sensitive code, it would stay forever for a one-time benefit to two accounts the operator holds, and it would put the hashes into the bundle. Instead the accounts import with no credential account; a password reset creates it (better-auth's `resetCredentialPassword`; `import.test.ts` signs in after one). The export never reads `password_hash`. Cost: `SMTP_URL` must work before the first sign-in (already a step 7 requirement), and two-factor is set up again.
2. **Roles.** `export --admin Andrew`: only Andrew is a site admin (decision 7); PieFed has both accounts as Admin, and `feddit-admin` imports as a user. It stays owner of both communities (PieFed's owner flag for `announcements`, its creator for `microblogs`).
3. **Ids are PieFed's `public_url()`**, what peers stored: `https://feddit.com/u/Andrew` with the capital (the archive's `ap_profile_id` is lowercase). Key ids are `<id>#main-key`, inbox `<id>/inbox`, outbox `<id>/outbox`, shared inbox `/inbox`; communities also `/followers`, `/featured`, `/moderators`, as PieFed serves them.
4. **The instance actor keeps PieFed's `/actor`**, `/actor/inbox`, `/actor/outbox` and key `/actor#main-key` (PieFed source and the live lab PieFed agree), not peblish's root id, as G0's contract for the cutover import says. peblish does not route `/actor` yet (request 1).
5. **Follow ids** are `https://feddit.com/activities/follow/<join request uuid>`, what PieFed 1.8 sent; the local follow of `announcements` has none. Follows import accepted with PieFed's membership time.
6. **Remote communities** go through core's `storeRemoteActor` with PieFed's cached fields and public key, `raw` null; the next refresh from the peer replaces them. PieFed cached Lemmy communities' inbox as the shared `/inbox`; kept (Lemmy takes deliveries there). The instance rows get no software until NodeInfo is read, so `verify` shows "unknown".
7. **Deviation, write path.** Core has no mutation for an imported local actor (the ones that exist mint ids from the name and generate keys), and adding one is outside this lane's write set. The import writes the local rows inside core's `tx()` (tools may open one), mirroring `insertAccount` and `createCommunity` and using core's `markdown`, `replaceLanguages` and table definitions, and stores remote communities through the `storeRemoteActor` mutation with a system `import` grant. It emits `actor.created` per local actor and `follow.accepted` per follow, which queues the backfill of each followed remote community; nothing is sent.
8. **No age declarations** are imported (core's rule for imported accounts): NSFW stays hidden until each declares in settings.
9. **A rehearsal rewrites the email addresses** to `<name>@<rehearsal host>` along with the ids: the rehearsal proves ids and keys, so a throwaway database (Easypanel in step 2) holds no one's real address. Private keys stay real, since verifying them is the point.
10. **The archive was restored through stdin** (`docker exec -i ... pg_restore < dump`), so no copy of the dump landed in the container, unlike FIT's steps.
11. **The drill re-applies the whole ledger**, not just the rows the backup lacks: every rule is idempotent and the end state then follows the ledger whichever copy held a row. The ledger export is separate from the backup and should run more often (runbook: hourly, backups nightly).
12. **Error output is sanitised**: a Drizzle error's message carries the query parameters (keys, addresses) and an ArkType error the offending value, so the CLI prints codes, constraint names and paths only.
13. **The lab name check inserts the account with SQL** in the runner (the runner image has only `tools/interop`'s dependencies), in the same shape the import writes. `make reset` removed all lab data, as `make check` does.

## 5. Requests to root

1. **Before cutover: serve PieFed's instance actor.** In `packages/federation/src/http.ts` (FED-A's) add `/^\/actor$/` to the negotiated or federation paths and `/^\/actor\/(inbox|outbox)$/` to `federationPaths` (and `/actor/inbox` to `inboxPaths`); `localDocument` already serves the actor by its stored id, and the instance actor's collection lookup (`${origin}${collection[1] || '/'}` in `actors/serve.ts`) needs to find it at `/actor`. Why: peblish signs authorized fetches with the stored instance key `https://feddit.com/actor#main-key` (`signing/instance.ts`), so a secure-mode peer that fetches that key gets 406 today. Also `relay/consumer.ts` `sendSiteBan` names `instanceActorUrls(origin).apId` (`https://feddit.com/`) as the Block's target where the stored instance actor is `/actor`; read the stored id.
2. **CI: Postgres client 17** in the check job (ubuntu-24.04 ships 16, which refuses a 17 server), for example PGDG's `postgresql-client-17`, so `drill.test.ts` runs there instead of skipping.
3. **Lockfile**: commit 0308ec4 is the importer block for `tools/cutover` (no new versions).
4. **Ownership**: add `tools/cutover/**` and `deploy/cutover.md` (B06) to the README table; `deploy/**` is root's and the brief handed me `deploy/cutover.md`.
5. **`plans/feddit/phase-1.md`, cutover step 8**: the Lemmy name question is answered (accepted); step 3's inventory is confirmed (above).

## 6. Requests to other lanes, through root

- FED-A (or whoever holds federation now): request 1.

## 7. Dependencies added

None new. `tools/cutover` depends on versions already in the lockfile: `@peblish/core`, `@peblish/federation`, `@peblish/schema` (workspace), `arktype` 2.2.9 (MIT), `drizzle-orm` 0.45.4 (Apache-2.0), `postgres` 3.4.9 (Unlicense), `uuidv7` 1.2.1 (Apache-2.0).

## 8. For later lanes

- `node tools/cutover/src/cli.ts` with `inventory`, `export`, `import`, `verify`, `backup`, `ledger-export`, `restore`, `drill` (usage at the top of `cli.ts`; the runbook has every command).
- Migrate the target **without** `PUBLIC_ORIGIN` before `import`; set it afterwards. `import` refuses a minted instance actor.
- A new `deletion_ledger` reason needs a rule in `drill.ts` (`apply`), or a restore stops at it.
- Step 2 reuses the bundle at `<scratch>/b06/bundle.json` (mode 600) with `--rehearsal-host <subdomain>`; reach the Easypanel Postgres through an SSH tunnel and record how, since step 7 does the same.

## 9. Left open and risks

- Request 1 blocks the cutover (go or no-go item 1).
- The final dump will be PieFed 1.8.11 (`61f3520d99b2`); re-run the opt-in archive tests on it before exporting (runbook step 6).
- PieFed's 25 banned instances are not carried; re-enter the ones wanted in `/admin/peers`.
- `announcements` was PieFed `local_only`; peblish has no such switch, so it federates after cutover.
- 9 follows sit on dormant instances and will show in the week-one "not delivered" query; re-Follow only if the community lives.
- The lab check proves Lemmy 0.19.21; piefed.social and lemmy.world are checked live at step 8.
- An older volume `feddit-lab_feddit-db` (not in the current lab compose file) was left as found.
- Scratch databases `piefed_archive` and `peblish_b06_rehearsal` are dropped. The bundle stays at `<scratch>/b06/bundle.json` (mode 600) for step 2, with the drill files and run logs (also mode 600). The archive was read only by the tools.

## Step 1b (2026-11-10)

Root accepted step 1, the password decision and `Andrew` as the only admin, and widened the write
set to the instance actor routing in `packages/federation/src/http.ts`, the site-ban Block in
`packages/federation/src/relay/consumer.ts` and their tests.

### What landed

| Item                      | Where                                          | Proof                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. `/actor` served        | `packages/federation/src/http.ts`              | `http.test.ts`: imported case (`/actor` by Accept, its key, `/actor/inbox` 401 unsigned, `/actor/outbox`, `/` declined) and fresh case (`/actor` declined, `/actor/inbox` and `/actor/outbox` 404); `verify.test.ts` now expects every id routed |
| 2. Site-ban Block target  | `packages/federation/src/relay/consumer.ts`    | `withdraw.test.ts`: the Block targets `https://fed-a.test/` on a fresh instance and `https://fed-a.test/actor` with PieFed's id                                                                                                                  |
| 3. Banned instances       | `tools/cutover/src/{archive,bundle,import}.ts` | `import.test.ts` (blocks, keeps a peer's media, private modlog rows, `peer.updated`, a second run blocks nothing); `archive.test.ts` (opt-in) counts 25                                                                                          |
| 4. Merge of `origin/main` | not done                                       | `origin/main` was still 29fbfec at every check, the last after the final commit; I did not wait                                                                                                                                                  |

Banned instances on feddit.com: **25** (PieFed's default list plus threads.net), all valid hosts,
none the host of a community `feddit-admin` follows.

Repeated local rehearsal with the new bundle: import of 1 instance actor, 2 users, 2 communities,
130 remote communities, 131 follows and 25 peer blocks (25 private `peer.update` modlog rows);
second run all present; `verify` 5 of 5 keys pass and are routed, 131 follows accepted, 0 held;
migrate with `PUBLIC_ORIGIN` keeps the imported instance actor; drill counts identical (54
instances now, with the 25 blocked hosts). Built server on 18323: `/actor` answers the Application
with `/actor#main-key`, `/actor/outbox` its collection, `/actor` as HTML the UI's 404; unsigned
POSTs to `/actor/inbox`, `/inbox` and `/u/feddit-admin/inbox` answer 401; the users, communities,
WebFinger and NodeInfo answer as before. `/` with ActivityPub Accept falls to the HTML page, since
the imported instance actor lives at `/actor`.

### Commits

| Commit  | Subject                                                          |
| ------- | ---------------------------------------------------------------- |
| 822a61b | Serve an imported PieFed instance actor at its stored id, /actor |
| 1dba6da | Name the stored instance actor as a site ban's Block target      |
| d74aa63 | Carry PieFed's banned instances over as peer blocks              |
| 42cd0a0 | Record the repeated local rehearsal in the cutover runbook       |
| (this)  | Record step 1b in the B06 lane notes                             |

### Verification

`pnpm check` green before each commit: 822a61b 2,611 passed and 9 skipped; 1dba6da 2,612 and 9;
d74aa63 and 42cd0a0 2,613 and 9. The first check of 822a61b failed on my own `verify.test.ts`,
which still asserted `/actor` unrouted; the commit updates it. The opt-in archive tests pass (2)
with `CUTOVER_ARCHIVE_DB_URL` set. No e2e run: no page changed, and the UI still gets `/actor` for
an HTML request.

### Decisions and deviations

14. **`/actor` by stored id.** `/actor` is chosen by Accept as `/` is and served by `localDocument`
    from the stored ap_id, so no second actor exists and a fresh peblish declines it (UI 404).
    `/actor/inbox` takes POSTs only where the stored instance actor's inbox is that URL (one
    indexed read per request to that path); elsewhere it is 404. `/actor/outbox` is served by the
    existing collection lookup.
15. **The site-ban Block.** In the code the instance actor is the Block's target (`target`), and the
    actor is the banning moderator, as Lemmy expects; root's item said "actor", I changed the
    target. The consumer now reads the stored instance actor's ap_id and throws if there is none.
16. **Deviation, peer blocks are not written through `updatePeer`.** MODF's `peer.update` policy
    accepts only a local admin with two-factor on, and `recheck: true` re-reads that from
    `auth_user`, while the import runs as the instance before anyone can sign in. Changing the
    policy is outside this lane's write set. So the import writes exactly what `updatePeer` writes
    for a block, with core's `ensureInstance`, `peer_controls`, `writeModlog` (authority: system,
    job `import`, ref `cutover`; action `peer.update`, not public) and the `peer.updated` event,
    in its one transaction. It keeps a peer's media and pause settings, and leaves a peer already
    blocked alone (idempotent). See request 6.
17. **The bundle gained `blockedInstances`** (domains only; banned_instances' reason, initiator and
    dates are not read). The format name stays `peblish.cutover/1`: a step 1 bundle no longer
    validates, and the scratch bundle was re-exported. `export` refuses a domain that is not a host.

### Requests to root

1. Done (items 1 and 2 above).
2. **Let the import call `updatePeer`.** In `packages/core/src/authz/actions/peers.ts` (MODF's),
   allow `principal.kind === 'system' && principal.job === 'import'` in `peerUpdate`, returning
   `allow({ kind: 'system', actorId: principal.actorId, job: 'import', ref: null })`; then
   `importPeerBlock` in `tools/cutover/src/import.ts` becomes `updatePeer.within(t, grant, {
blocked: true, reason })` after an already-blocked check. Not needed for the cutover; it removes
   the duplicated write.

### Left open

- Item 4: `origin/main` had not moved past 29fbfec when I finished; the merge of interop PR #6 is
  still to do (I expect conflicts only in `relay/consumer.ts` and `relay/*.test.ts`, which #6 also
  touches).
- The scratch database `piefed_archive` was restored again for item 3 and is dropped at the end of
  this run, with `peblish_b06_rehearsal`. The re-exported bundle stays at `<scratch>/b06/bundle.json`
  (mode 600) for step 2.
