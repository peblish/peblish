# feddit.com cutover runbook

Moves feddit.com from PieFed 1.8.11 on `box.feddit.com` to peblish, cutover steps 3 to 10 of the
Phase 1 plan. Only identities move: the instance actor, the two local users (`feddit-admin`,
`Andrew`), the two local communities (`announcements`, `microblogs`), each with its ap_id, inboxes
and RSA key, and `feddit-admin`'s 131 follows as accepted rows (decision 3). No posts, comments,
cached remote content or password hashes move.

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
or any error writes nothing (one transaction). `verify` signs a delivery with every imported key
as the delivery worker does, verifies it as the inbox does against the stored public key, checks
the served actor document names that key and that it is the bundle's (what peers cached), and
lists every follow with the inbox its posts and Undo go to. It exits 1 if any key fails.

Local rehearsal, 2026-11-10 (lane B06): import 2.2 s, 1 instance actor, 2 users, 2 communities,
130 remote communities, 131 follows; second run all present; verify 5 of 5 keys pass, 131 follows
accepted, 0 held, 28 hosts; migrate with `PUBLIC_ORIGIN` keeps the imported instance actor; drill
counts identical. Host-header pretest of the built server: `/u/feddit-admin`, `/u/Andrew`
(`/u/andrew` resolves to it), both communities, WebFinger for all three and NodeInfo 2.1 with
usage answer; `GET /actor` answers 406 and `POST /actor/inbox` 404 (see "Before the go-ahead").

The Easypanel rehearsal on a throwaway peblish.com subdomain (B06 step 2) repeats this with every
kill switch off (federation off), then tears the project, its DNS record and its database down.

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
node tools/cutover/src/cli.ts drill --db $DATABASE_URL --dir $S/drill   # backup, export, restore to <db>_drill, re-apply, compare, drop
```

`restore` appends the exported rows the backup lacks (same ids, sequence moved past them), then
applies every ledger row in id order in one transaction: remote object and actor deletions (with
the actor's content when `removeContent`), their undeletions, local account deletions (the
better-auth user goes again) and blocked media. A row with no rule stops the restore and changes
nothing; add the rule before going live. Point the services at the restored database only after
it reports. Run the drill once before the first outside invitee and once in week one.

## Step 5: cutover gate (not this runbook's)

B07 closed, kill switches tested, M31 pages live, Cloudflare CSAM tool on, NCMEC test report done,
DMCA agent registered, rota agreed, drills passed once.

## Before the go-ahead: go or no-go

All must hold, else stay on PieFed:

1. `GET https://<new origin>/actor` with `Accept: application/activity+json` returns the imported
   Application (PieFed's instance actor id, whose key `/actor#main-key` peblish signs its
   authorized fetches with) and `POST /actor/inbox` reaches the inbox. Not yet true (request to
   root in B06's notes).
2. The Easypanel rehearsal passed and was torn down; this runbook's commands were run there as written.
3. The final archive (step 6) inventories the same as above, or the differences are understood.
4. `verify --bundle` on production exits 0: 5 keys, every one matching the bundle; 131 follows accepted.
5. The host-header pretest below passes against the new origin.
6. A drill on the production database passed, and the nightly backup and hourly ledger export run.
7. `Andrew` has signed in through a password reset, turned on two-factor and set `site.name` to
   "Feddit", the operator settings and the published pages.

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

1. Production Easypanel project (decision 9) with `postgres`, `web`, `worker` as in `README.md`.
   Run the first migrate with `PUBLIC_ORIGIN` **unset**. Then reach its Postgres from the
   operator machine through an SSH tunnel (the way the Easypanel rehearsal did) and import:

   ```sh
   export DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<tunnel port>/<db> PUBLIC_ORIGIN=https://feddit.com
   node tools/cutover/src/cli.ts import --bundle $S/bundle-final.json
   node tools/cutover/src/cli.ts verify --bundle $S/bundle-final.json
   ```

2. Set `PUBLIC_ORIGIN=https://feddit.com`, `BETTER_AUTH_SECRET`, `SMTP_URL`, `MAIL_FROM` and
   `PEBLISH_TRUSTED_PROXY=cloudflare` on `web` and `worker`; the origin accepts Cloudflare's
   address ranges only (Easypanel or host firewall). Turn `inbox.enabled` and `delivery.enabled`
   off until step 8, so peers get 503 with `Retry-After` and nothing is sent early.
3. Sign in (point feddit.com at the new origin in the admin's own hosts file): `Andrew` asks for a
   password reset at `/auth/reset`, sets a password, turns on two-factor at `/settings/security`.
   `feddit-admin` does the same when needed. No account has an age declaration (NSFW stays hidden
   until each declares in settings).
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

1. Turn `inbox.enabled` and `delivery.enabled` back on.
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
