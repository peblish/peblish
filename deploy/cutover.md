# feddit.com cutover runbook

Moves feddit.com from PieFed 1.8.11 on `box.feddit.com` to peblish, cutover steps 3 to 10 of the
Phase 1 plan. Only identities move: the instance actor, the two local users (`feddit-admin`,
`Andrew`), the two local communities (`announcements`, `microblogs`), each with its ap_id, inboxes
and RSA key, `feddit-admin`'s 131 follows as accepted rows (decision 3), and PieFed's 25 banned
instances as peer blocks. No posts, comments, cached remote content or password hashes move.

**Steps 6 to 10 touch production and run only after Andrew's explicit, named go-ahead (step 6).**
Steps 3 and 4 touch nothing live.

The tool is `tools/cutover` (`node tools/cutover/src/cli.ts <command>`, from a checkout of the
release commit with `pnpm install` done, Node 24 and Postgres client tools 17 on `PATH`).

## Handling secrets

The PieFed dump, the key files and the bundle hold private keys, password hashes and email
addresses. Keep them in the archive folder (700) or a scratch folder (700, files 600), never in
the repository (the tool refuses to write there), never in a chat, log or ticket. The tool writes
the bundle, backups and ledger exports with mode 600 and refuses an existing file, prints ids,
URLs, counts and key fingerprints only, and withholds database error details (they can carry
values). The tool never reads PieFed's password hashes. Drop the scratch databases when done.

## Step 3: inventory (no production access)

Restore the archive into a scratch database through stdin, so no copy of the dump lands in a
container, then read the inventory:

```sh
A=/Users/admin/Projects/feddit-archive/<date>
createdb -h 127.0.0.1 -p 18432 -U peblish piefed_archive
docker exec -i peblish-dev-postgres-1 pg_restore -U peblish -d piefed_archive --no-owner --no-privileges < $A/piefed-db.dump
export CUTOVER_ARCHIVE_DB_URL=postgres://peblish:peblish@127.0.0.1:18432/piefed_archive
node tools/cutover/src/cli.ts inventory
```

Result on the 2026-11-08 archive (PieFed schema `7c5a293ed40c`):

| Question                                  | Answer                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `announcements` members                   | 1, local (`feddit-admin`, its owner); the community is PieFed `local_only`, so it never federated                                                                                                                                                                                                         |
| `microblogs` members                      | 0                                                                                                                                                                                                                                                                                                         |
| Chat messages, conversations              | 0, 0                                                                                                                                                                                                                                                                                                      |
| Local posts, local comments               | 0, 0                                                                                                                                                                                                                                                                                                      |
| `feddit-admin` follows                    | 131: 130 remote communities on 28 instances (129 Lemmy, 1 PieFed) plus the local `announcements`                                                                                                                                                                                                          |
| Accepted state                            | All 131 are PieFed memberships, which PieFed writes when the Accept arrives (or at once for a local community); 130 carry the Follow id PieFed sent (`/activities/follow/<join request uuid>`); 0 join requests wait unanswered. PieFed kept no activity log, so the Accepts themselves cannot be re-read |
| On instances PieFed marks dormant or gone | 9 of the 130                                                                                                                                                                                                                                                                                              |
| `Andrew` follows                          | 0                                                                                                                                                                                                                                                                                                         |
| Banned instances                          | 25 (PieFed's default list plus threads.net), none the host of a followed community                                                                                                                                                                                                                        |

Subscription continuity (decision 3): import the 131 as accepted rows under the unchanged actor,
inbox and keys; sample-verify in the rehearsal and in week one; re-Follow only those that do not
deliver (step 10).

## Step 4: rehearsal on a throwaway host (no production access)

Actor ids embed the host, so a rehearsal proves the import and the tooling, not peer acceptance.
`--rehearsal-host` moves the bundle's local ids onto the throwaway host; remote ids stay.

```sh
S=<scratch folder, mode 700>
# The bundle, cross-checked against the key files exported with the archive.
node tools/cutover/src/cli.ts export --admin Andrew --archive-dir $A --out $S/bundle.json

# A fresh database migrated WITHOUT PUBLIC_ORIGIN: the import brings the instance row and actor.
createdb -h 127.0.0.1 -p 18432 -U peblish peblish_rehearsal
export DATABASE_URL=postgres://peblish:peblish@127.0.0.1:18432/peblish_rehearsal
env -u PUBLIC_ORIGIN node packages/core/src/db/migrate-cli.ts

export PUBLIC_ORIGIN=https://rehearsal.peblish.test
node tools/cutover/src/cli.ts import --bundle $S/bundle.json --rehearsal-host rehearsal.peblish.test
node tools/cutover/src/cli.ts import --bundle $S/bundle.json --rehearsal-host rehearsal.peblish.test   # again: all "present"
node tools/cutover/src/cli.ts verify --bundle $S/bundle.json --rehearsal-host rehearsal.peblish.test
node packages/core/src/db/migrate-cli.ts       # later deploys migrate with PUBLIC_ORIGIN set: keeps the imported instance actor
node tools/cutover/src/cli.ts drill --db $DATABASE_URL --dir $S/drill
```

`import` refuses a bundle whose host is not `PUBLIC_ORIGIN`'s (without `--rehearsal-host`), a
database whose migrate minted an instance actor, and a stored actor with another key; a refusal
or any error writes nothing (one transaction). It blocks each banned instance as a peer the way
`/admin/peers` does (peer controls `blocked`, a private `peer.update` modlog row, `peer.updated`),
keeping a peer's other controls and leaving one already blocked alone; the summary lists them. `verify` signs a delivery with every imported key
as the delivery worker does, verifies it as the inbox does against the stored public key, checks
the served actor document names that key and that it is the bundle's (what peers cached), and
lists every follow with the inbox its posts and Undo go to. It exits 1 if any key fails.

Local rehearsal, 2026-11-10 (lane B06, repeated with the peer blocks and the `/actor` routing):
import of 1 instance actor, 2 users, 2 communities, 130 remote communities, 131 follows and 25
peer blocks; second run all present; verify 5 of 5 keys pass and are routed, 131 follows
accepted, 0 held, 28 hosts; migrate with `PUBLIC_ORIGIN` keeps the imported instance actor; drill
counts identical. Host-header pretest of the built server: `/actor` (the Application, key
`/actor#main-key`), `/actor/outbox`, `/u/feddit-admin`, `/u/Andrew` (`/u/andrew` resolves to it)
and both communities answer their documents; unsigned POSTs to `/actor/inbox`, `/inbox` and an
actor inbox answer 401; WebFinger and NodeInfo 2.1 with usage answer. `/` serves the HTML page
only: the imported instance actor lives at `/actor`.

### On Easypanel: how the import reaches the database

The import runs inside the Easypanel project, never over an exposed Postgres or a tunnel. A
temporary `cutover` App service is built from the same uploaded source as `web` and `worker` with
build type Dockerfile and file `tools/cutover/Dockerfile` (the tool, Postgres 17 client tools,
psql and curl; it runs `sleep infinity`). Its only environment is `DATABASE_URL` (the project's
internal Postgres host, `<project>_postgres:5432`), `PUBLIC_ORIGIN` and, in a rehearsal, the
Mailpit URL. The operator copies the bundle into its console with echo off to
`/tmp/cutover/bundle.json` (mode 600, directory 700), compares its SHA-256 with the local
copy, and runs the commands there. When done, `rm -rf /tmp/cutover/*`, then destroy the service.
No image layer ever holds the bundle.

Order on a fresh project, each step read back before the next:

1. `postgres` (17, not exposed), then `cutover`: upload the source, then set the build (Easypanel
   refuses a build setting before a source exists), then its environment, then deploy.
2. In the `cutover` console: migrate with `PUBLIC_ORIGIN` unset, then set the kill switches
   before `web` or `worker` exists and before the import (no admin can sign in yet, so this is
   SQL). `delivery.enabled` is the federation switch: off, no process sends or fetches anything.

   ```sh
   cd /app && env -u PUBLIC_ORIGIN node packages/core/src/db/migrate-cli.ts
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "insert into site_settings (key, value) values
     ('delivery.enabled', 'false'::jsonb), ('registration.enabled', 'false'::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()"
   ```

3. Copy the bundle in, then `import` (twice: the second is all `present`) and `verify`, as above.
4. `web` with its domain (HTTPS) and environment. A `worker` may run with the imported follows
   only while the federation switch is off (below). Then the served-documents check, the password
   reset with two-factor enrolment, and the drill.

Easypanel starts a deployment by itself when a service's source is uploaded, so a service runs
as soon as it has code, not only when deployed. A `deployService` request can time out at the
panel's proxy (HTTP 524) while the build goes on: poll the service's actions until the new one is
`done`.

**The federation switch decides whether peers are contacted.** On start the worker runs every
job once: it mirrors the moderators of each followed remote community (`federation.moderators`),
runs the backfills that accepting the 131 follows queued (`federation.backfill_run`), and fetches
the actors, posts and instance NodeInfo those bring. With `delivery.enabled` off (the label is
"Sending and fetching") none of that leaves the server: delivery, backfill, the moderator mirror,
NodeInfo refresh, remote fetch and resolve, dormancy probes and key fetches all wait, and an
inbound activity that needs a fetch answers 503 with `Retry-After`. So the switch is set off
before the import, a worker may start with the imported follows only while it is off, and it is
turned on only at the step where peers may be contacted (step 8 in production; never in a
rehearsal). This holds from the B07 fix batch on; the rehearsal below ran an earlier build, whose
switch stopped deliveries only.

### Easypanel rehearsal, 2026-11-10 (lane B06 step 2)

Project `peblish-rehearsal` on 38.102.126.114, A record `rehearsal-1.peblish.com` (DNS only, TTL
60), branch `mvp-w4-b06`. Services `postgres` 17.11, `cutover`, `web` (basic auth), `mailpit`,
`minio`, `worker`. Differences from staging: the MinIO root credentials served as the S3 keys and
no bucket was made (uploads are off and nothing reached S3), and the worker ran by mistake (below).

- Import: refused without `--rehearsal-host`. Then 1 instance actor, 2 users, 2 communities, 130
  remote communities, 131 follows and 25 peer blocks; the second run was all `present`. verify: 5 of 5
  keys pass and are routed and the bundle's, 131 follows accepted, 0 held, 28 hosts. 2 auth users,
  0 credential accounts, emails on the rehearsal host.
- Over HTTPS (Let's Encrypt certificate; 401 without basic auth): `/actor` (Application, inbox
  `/actor/inbox`, key `/actor#main-key`), `/actor/outbox`, `/u/feddit-admin`, `/u/Andrew` and both
  communities answer their documents, and each served public key is the bundle's. WebFinger for a
  user and a community, and NodeInfo 2.1 (peblish, 2 users, registrations closed), also answer.
- Andrew: a reset requested at `/auth/reset` reached Mailpit (sent by `web` itself; the worker is
  not involved), set the first password, and the used link was then refused. Sign-in worked, and a
  wrong password was refused. Until two-factor is on, the session's site role is `user` and
  `/admin/*` answers 403 ("needs two-factor"). After TOTP enrolment at `/settings/security` the
  role is `admin` and `/admin/peers` lists the 25 blocked peers.
- Drill in the `cutover` console: backup, ledger export, restore into `peblish_drill` and
  re-apply in 4 s, table counts identical (2,315 rows), ledger empty. Rollback by restore: `web`
  pointed at `peblish_drill` (its `DATABASE_URL` changed and redeployed) served the restored
  data (a change made to `peblish` after the backup was absent, Andrew's earlier session still
  valid, the 5 keys the bundle's). Pointed back, it served the change again.
- **Peers were contacted.** The worker auto-started when its source was uploaded (10:17:45 UTC)
  and ran until it was stopped (about 10:23). It fetched 268 actors, 155 posts and 116 comments
  from 41 hosts, mirrored 146 moderators and probed 41 instances' NodeInfo, signed as
  `https://rehearsal-1.peblish.com/actor`. It made no deliveries (`deliveries` was empty). The
  fix is the federation switch described above (B07 batch, O1).
- Teardown: services and project destroyed, DNS record deleted (authoritative NXDOMAIN), bundle and
  backups removed from the container first.

## Backups and the deletion ledger

`deletion_ledger` is append-only and records every deletion that must survive a restore (remote
Deletes and Tombstones, account deletions, blocked media). A restore loses every row written after
its backup, ledger rows included, so the ledger is also exported on its own, more often.

```sh
node tools/cutover/src/cli.ts backup --db $DATABASE_URL --out $S/backup-$(date -u +%Y%m%dT%H%M).dump      # nightly
node tools/cutover/src/cli.ts ledger-export --db $DATABASE_URL --out $S/ledger-$(date -u +%Y%m%dT%H%M).json  # hourly
# Restore into a NEW database, then re-apply the newest ledger export (and take a fresh export
# from the damaged database first if it still answers):
node tools/cutover/src/cli.ts restore --backup <dump> --db <new database url> --ledger <newest ledger export>
node tools/cutover/src/cli.ts drill --db $DATABASE_URL --dir $S/drill   # backup, export, restore into a new drill_<time>_<random>, re-apply, compare, drop it
```

`restore` appends the exported rows the backup lacks (same ids, sequence moved past them), then
applies every ledger row in id order in one transaction: remote object and actor deletions (with
the actor's content when `removeContent`), their undeletions, local account deletions (the
better-auth user goes again) and blocked media. A row with no rule stops the restore and changes
nothing; add the rule before going live. Point the services at the restored database only after
it reports.

`restore` and `drill` only ever create a database: they refuse one that exists and a name longer
than 63 bytes (Postgres would cut it to another name). The drill restores into
`drill_<time>_<random>` on the same server, marks it, and drops only the database carrying its
mark; it never ends another database's sessions. `--keep` leaves the drill's database for a
rollback test; drop it by hand afterwards. Run the drill once before the first outside invitee and once in week one.

## Step 5: cutover gate (not this runbook's)

B07 closed, kill switches tested, M31 pages live, Cloudflare CSAM tool on, NCMEC test report done,
DMCA agent registered, rota agreed, drills passed once.

## Before the go-ahead: go or no-go

All must hold, else stay on PieFed:

1. `GET https://<new origin>/actor` with `Accept: application/activity+json` returns the imported
   Application (PieFed's instance actor id, whose key `/actor#main-key` peblish signs its
   authorized fetches with) and `POST /actor/inbox` reaches the inbox (true locally since
   step 1b; check it on the new origin).
2. The Easypanel rehearsal passed and was torn down; this runbook's commands were run there as written.
3. The final archive (step 6) inventories the same as above, or the differences are understood.
4. `verify --bundle` on production exits 0: 5 keys, every one matching the bundle; 131 follows accepted.
5. The host-header pretest below passes against the new origin.
6. A drill on the production database passed, and the nightly backup and hourly ledger export run.
7. `Andrew` has signed in through a password reset, turned on two-factor in that session and set
   `site.name` to "Feddit", the operator settings and the published pages.

## Step 6: go-ahead and final archive (production; Andrew's named go-ahead)

Stop PieFed but keep it restorable (its database and volumes stay), then take the final archive:

```sh
ssh feddit@box.feddit.com 'cd ~/pyfedi && docker compose stop web celery piefednotifs'
ssh feddit@box.feddit.com 'cd ~/pyfedi && docker compose exec -T db sh -c "pg_dump -U \"\$POSTGRES_USER\" -Fc \"\$POSTGRES_DB\""' > $A/piefed-db.dump
```

(`$A` a new dated archive folder, 700.) Restore it as in step 3, run `inventory` (still 0 local
posts), then `export --admin Andrew --out $S/bundle-final.json`. The 2026-11-08 dump is schema
`7c5a293ed40c` and the box has run 1.8.11 since (`61f3520d99b2`): re-run the archive tests
(`CUTOVER_ARCHIVE_DB_URL=... pnpm exec vitest run --project tools tools/cutover/src/archive.test.ts`)
against the final dump before exporting. `box.feddit.com` is otherwise untouched: it is the
rollback target.

## Step 7: production import and origin switch (production)

1. Production Easypanel project (decision 9) with `postgres` and a temporary `cutover` service,
   in the order of "On Easypanel" (step 4): migrate with `PUBLIC_ORIGIN` **unset**, set
   `delivery.enabled` (the federation switch) and `registration.enabled` off and also
   `inbox.enabled` off (so peers get 503 with `Retry-After`), all before the import, copy the
   bundle in, then in the `cutover` console
   (`PUBLIC_ORIGIN=https://feddit.com`):

   ```sh
   node tools/cutover/src/cli.ts import --bundle /tmp/cutover/bundle-final.json
   node tools/cutover/src/cli.ts verify --bundle /tmp/cutover/bundle-final.json
   ```

2. Add `web` as in `README.md` with `PUBLIC_ORIGIN=https://feddit.com`, `BETTER_AUTH_SECRET`,
   `SMTP_URL`, `MAIL_FROM` and `PEBLISH_TRUSTED_PROXY=cloudflare`; the origin accepts Cloudflare's
   address ranges only (Easypanel or host firewall). `worker` (same source and environment as
   `web`, `PEBLISH_PROCESS=worker`) may be created now, with the federation switch still off:
   read `delivery.enabled` back as `false` first. Its jobs wait until step 8.
3. Sign in (point feddit.com at the new origin in the admin's own hosts file): `Andrew` asks for a
   password reset at `/auth/reset`, sets a password, signs in and turns on two-factor at
   `/settings/security` in that same session. Admin pages need a session that passed two-factor
   (enrolled or verified in it), not only an account with it on; enrolling signs every other
   session out. `feddit-admin` does the same when needed. No account has an age declaration (NSFW
   stays hidden until each declares in settings).
4. Host-header pretest against the new origin (`O` its address):

   ```sh
   R="--resolve feddit.com:443:$O"; AP='Accept: application/activity+json'
   for p in /actor /u/feddit-admin /u/Andrew /c/announcements /c/microblogs; do curl -s $R -H "$AP" -o /dev/null -w "$p %{http_code}\n" https://feddit.com$p; done
   curl -s $R 'https://feddit.com/.well-known/webfinger?resource=acct:feddit-admin@feddit.com'
   curl -s $R https://feddit.com/nodeinfo/2.1        # usage.users.total 2, localPosts present
   curl -s $R -X POST -H 'content-type: application/activity+json' -d '{}' -o /dev/null -w '%{http_code}\n' https://feddit.com/inbox   # 401 or 503, never 410, 418 or another 5xx
   ```

5. Switch the Cloudflare origin of feddit.com to the new origin in one step (the proxied DNS
   record). No cache rules on `/u`, `/c`, `/post`; the WAF must not block `POST /inbox`.

## Step 8: verify peers (production)

1. Peers may be contacted from here. Turn `inbox.enabled` and the federation switch
   (`delivery.enabled`, "Resume sending and fetching" at `/admin/settings`) back on; create
   `worker` now if step 7 did not. The worker starts the 130 queued backfills and the moderator
   mirrors at once. Run the drill and the cleanup in the `cutover` console
   (`rm -rf /tmp/cutover/*`), then destroy `cutover`.
2. `feddit-admin` delivery to piefed.social and lemmy.world: post in a followed community on each
   and see it there. In the lab Lemmy 0.19.21 resolved and accepted `feddit-admin` (B06 notes,
   "Lemmy name check"); if production disagrees, test with `Andrew`, which has no hyphen.
3. Sample the 131 follows: `verify` lists each with its inbox; after a day, the query in step 10
   shows which communities have delivered.
4. Follow a feddit.com community from Mastodon, Lemmy and PieFed accounts; open a canary community.

## Step 9: open (production)

Admins first, then invitees (cap about 25 for 30 days).

## Step 10: soak and retirement (production)

PieFed stays restorable for 7 days of soak and 30 days of restorability, then the box retires (keep
the final archive). Daily during the soak: `verify`, delivery failures in `deliveries`, inbox
refusals, backups and ledger exports present. After week one, the follows that have not delivered:

```sql
select a.ap_id, a.inbox_url from follows f
join actors a on a.id = f.followee_id and not a.local
where f.follower_id = (select id from actors where local and name = 'feddit-admin')
  and not exists (select 1 from posts p where p.community_id = a.id and p.created_at > '<switch time>')
order by a.ap_id;
```

Re-Follow only those (decision 3): as `feddit-admin`, leave and join each from its community page,
which sends Undo(Follow) and a new Follow. A dormant or quiet community also shows here; check its
own page first.

## Rollback

Before or during the soak: switch the Cloudflare origin of feddit.com back to `box.feddit.com`,
then start PieFed:

```sh
ssh feddit@box.feddit.com 'cd ~/pyfedi && docker compose up -d web celery piefednotifs'
```

Content created on peblish after the switch is not carried back (small in week one). The peblish
project stays as it is for diagnosis; do not run its worker against feddit.com while PieFed serves
it again.
