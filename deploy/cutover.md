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
URLs, counts and key fingerprints only, and prints an error's message only when it is its own:
a damaged bundle, key file or ledger export is named with a position or the failing paths, never
quoted, and a database, `pg_restore` or other error shows its code, constraint or kind, since
its text can carry values. The tool never reads PieFed's password hashes. Drop the scratch databases when done.

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
lists every follow with the inbox its posts and Undo go to. It exits 1 if any key fails (pair,
signature, served document, routing, or the bundle's key id and key), if an actor the bundle holds
is missing or an imported actor has no key or no private key (each listed by id), or if it found
nothing to check.

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

   The migrate applies every migration, `0013_edge_cache_purges` included: two new tables for the
   edge cache's purges (`edge_purges`, `edge_status`) and no change to existing ones.

3. Copy the bundle in, then `import` (twice: the second is all `present`) and `verify`, as above.
   `import` turns the federation switch off itself, in a transaction of its own before it reads
   the bundle, so it stays off even when the import is refused; its report says so
   (`"federation": { "deliveryEnabled": false, "wasOn": false }` after the SQL above). Once the
   database has its instance actor (a repeat run), it does so through `settings.update` as the
   system import principal, which may set only this switch and only to off, so a change it makes
   has a private `settings.update` modlog row and `settings.updated`; on the fresh database there
   is no actor yet for them to name, and it writes the row as the SQL does. The SQL stays as the
   check, and for the other switches.
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
Deletes and Tombstones, account deletions, blocked media, hashes an admin adds to or removes from
the blocked-image list). A restore loses every row written after its backup, ledger rows
included, so the ledger is also exported on its own, more often.

On Easypanel this runs by itself: the `backup` service uploads a dump every night and a ledger
export every hour to a bucket of its own, and a restore fetches them from there
([backups.md](backups.md)). The commands below are the same steps by hand.

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
better-auth user goes again) and blocked media, whole: the row blocked again, its hash back on
the list and every clean copy of it the backup holds quarantined again (core's own block path, so
each copy gets its incident and a `media.quarantined` event in the restored outbox), even when the
blocked row itself is newer than the backup. A hash an admin listed by hand is listed again with
its category and reason, and its clean copies are quarantined the same way; a hash an admin
removed is removed again (by value, after any earlier row that listed it; images it caught stay
as they are, as on removal). Each ledger row names the hash for this. A row with no rule stops
the restore and changes nothing; add the rule before going live. Point the services at the
restored database only after it reports.

The ledger replay also owes a purge of the whole edge cache (`pbm`), late from the start, so
proxy images are answered `private` until the worker has sent it, normally within 20 seconds of
the worker starting on the restored database ([edge-cache.md](edge-cache.md) section 1). If the
services now name a different Cloudflare zone from the one in the restored `edge_status.zone_id`,
answers stay `private` until the worker's first request for the new zone succeeds.

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
6. A drill on the production database passed, and the nightly backup and hourly ledger export run:
   the production `backup` service is up on R2 ([backups.md](backups.md)), `backup-status` in its
   console exits 0, and one drill ran on a backup and ledger export fetched from the bucket.
7. `Andrew` has signed in through a password reset, turned on two-factor in that session and set
   `site.name` to "Feddit", the operator settings and the published pages.
8. The TLS rehearsal (below) recorded which certificate path works on this Easypanel, path A (a
   DNS-challenge certificate) or path B (a Cloudflare Origin CA certificate), with the date and how
   the certificate was installed, and its checks passed on a proxied `peblish.com` test hostname.
   Done 2026-11-11 on `tls-1.peblish.com`: path A, the certificate inline in Easypanel's Traefik
   custom config, every check below passed, then torn down. If production runs on another
   Easypanel server, its custom config must be read empty (or its contents kept) first.
9. Before step 6 stops anything, the feddit.com certificate of that path is on the new origin and
   its check (below) passes: a certificate both Andrew's browser and Cloudflare trust.

## TLS on the new origin (before step 6; path A rehearsed 2026-11-11)

**The requirement:** before PieFed stops (step 6), the new origin serves feddit.com with a
certificate that both Andrew's browser and Cloudflare (SSL/TLS mode Full (strict)) trust. Andrew's
browser reaches the new origin directly for the sign-in (step 7 items 4 and 5, through a hosts
file line), and Cloudflare reaches it after the switch. A Let's Encrypt HTTP challenge cannot pass
before the switch, since Cloudflare still sends feddit.com to the box. Two paths; root prefers A.

- **Path A (preferred): a publicly trusted certificate from a DNS challenge.** Let's Encrypt checks
  a TXT record, not the origin, so it can be issued before the switch. Browsers and Cloudflare
  trust it, so the sign-in works with only the hosts line, and the pretest uses normal trust.
- **Path B (alternative): a Cloudflare Origin CA certificate.** Only Cloudflare trusts it. The
  sign-in then needs an isolated browser profile that trusts Cloudflare's origin root (below,
  removed after), and the pretest passes that root with `--cacert`.

**The rehearsal** (go or no-go item 8, 2026-11-11, Easypanel at 38.102.126.114, project
`peblish-tls` with `postgres` and `web` only, no worker, federation switch off) used the proxied
test hostname `tls-1.peblish.com`, first pointed at 192.0.2.1 (nothing answers, as feddit.com
points at the box), and proved path A end to end:

- A Let's Encrypt certificate by DNS challenge from Andrew's machine (issuer YE1, 90 days).
- Easypanel has no certificate field on a domain (a domain only names a certificate resolver).
  It takes a custom certificate in its Traefik custom config, set with the API procedure
  `traefik/setCustomConfig` (Easypanel's guide does the same with a `custom.yaml` file under
  `/etc/easypanel/traefik/config/` over SSH; Andrew's machine has no SSH key for this server). The certificate and key
  go inline, so no file and no SSH is needed. Traefik served it within seconds, with no restart,
  and before any domain existed.
- With the hosts override and normal trust: `TLS ok, http 200` on `/healthz`, `/readyz` and
  `/auth/sign-in` behind basic auth, `Verify return code: 0 (ok)`, and an isolated browser session
  loaded the sign-in page while refusing a name with no certificate.
- After the switch (the proxied record to the origin): `/healthz` 200 through Cloudflare.
- Renewal: with the custom certificate removed, Traefik's own Let's Encrypt resolver got a
  certificate by HTTP challenge through the Cloudflare proxy in about 15 seconds.

The peblish.com zone runs SSL/TLS mode Full, not Full (strict): read from behaviour, since the
Cloudflare token cannot read zone settings (403 on both zones). Through Cloudflare HTTPS worked
(Flexible would loop on Traefik's redirect to HTTPS), and after five idle minutes Cloudflare still
answered 200 while the origin served a self-signed certificate (Full (strict) answers 526). Its
"Always Use HTTPS" is off: the challenge path over HTTP reached Traefik through Cloudflare. The
feddit.com zone's two settings could not be read either; Andrew reads both in the dashboard
before step 6 (below).

**Path A, issue.** On Andrew's machine, with lego 5.6.0 (`brew install lego`, or the release
archive checked against its `checksums.txt`) and a Cloudflare API token limited to Zone, DNS,
Edit and Zone, Zone, Read on the feddit.com zone. The token is a secret: `read -rs` keeps it in
the shell's memory, never on screen, in a file or in the history.

```sh
read -rs CLOUDFLARE_DNS_API_TOKEN && export CLOUDFLARE_DNS_API_TOKEN    # paste the token, Enter
lego run --accept-tos --path $S/lego --dns cloudflare --dns.resolvers 1.1.1.1:53 -d feddit.com
openssl x509 -in $S/lego/certificates/feddit.com.crt -noout -subject -issuer -enddate -ext subjectAltName
```

`lego` must log "Server responded with a certificate"; the `openssl` line must show
`DNS:feddit.com` and a Let's Encrypt issuer. `--dns.resolvers 1.1.1.1:53` matters on a machine
with Tailscale: its resolver (100.100.100.100) answered NXDOMAIN for the challenge record and
lego gave up after two minutes. Without `--email` the Let's Encrypt account has no contact
address; the account key, certificate and key stay in `$S/lego` (700).

**Path A, install.** First read the server's Traefik custom config. It was empty on this server;
if it is not, add the `tls` block to what is there and never replace other content. Then build the
file (Traefik reads PEM given inline in `certFile` and `keyFile`) and set it, here through the API
with the key from `~/.agents/easypanel.env`, kept off the command line:

```sh
set -a; . ~/.agents/easypanel.env; set +a
EP() { printf 'header = "Authorization: %s"\n' "$EASYPANEL_API_KEY" | curl -sS -K - "$@"; }
EP "$EASYPANEL_URL/api/rpc/traefik/getCustomConfig"; echo     # {"json":""} when empty
(umask 077; { printf 'tls:\n  certificates:\n    - certFile: |\n'; sed 's/^/        /' $S/lego/certificates/feddit.com.crt
  printf '      keyFile: |\n'; sed 's/^/        /' $S/lego/certificates/feddit.com.key; } > $S/custom.yaml
  python3 -c 'import json,sys; print(json.dumps({"json": {"config": open(sys.argv[1]).read()}}))' $S/custom.yaml > $S/custom.json)
EP -H 'Content-Type: application/json' --data-binary @$S/custom.json "$EASYPANEL_URL/api/rpc/traefik/setCustomConfig"; echo
```

The read-back of `getCustomConfig` now holds the private key: compare it, never print it. No
Traefik restart is needed (a restart is panel-wide). Then create the production `web` domain
(HTTPS, port 3000, certificate resolver left blank, which is Easypanel's Let's Encrypt resolver),
with no source uploaded (Easypanel starts a service once it has code, step 4), so nothing runs.
Install before creating the domain: Traefik's resolver skips a name a stored certificate covers,
so it never tries an HTTP challenge before the switch (that would fail while Cloudflare points at
the box, and failures count toward Let's Encrypt's limit of 5 an hour per name). In the rehearsal
the name stayed out of Traefik's certificate list until the custom certificate was removed. A
custom certificate also wins over a Traefik certificate for the same name.

**Path A, renewal** (rehearsed). Once Cloudflare reaches the new origin (step 7 item 8), hand the
certificate to Traefik: set the custom config back to what it held before (empty here,
`{"json": {"config": ""}}`). Traefik's resolver then gets its own certificate by HTTP challenge
through Cloudflare and renews it itself; the rehearsal had it in 15 seconds. Two conditions:

- The challenge request (`http://feddit.com/.well-known/acme-challenge/...`) must reach Traefik
  on port 80: feddit.com's "Always Use HTTPS" off, or a rule that leaves that path on HTTP. If the
  edge redirected it to HTTPS, it would reach the app instead of Traefik's challenge handler and
  fail (reasoned, not tried: peblish.com has the setting off).
- Until Traefik has its certificate the origin serves Easypanel's default one, so under Full
  (strict) Cloudflare should answer 526 for those seconds (expected; under peblish.com's Full it
  answered 200). Do it in a quiet moment, then read `openssl s_client` (below) until the issuer
  is Let's Encrypt with a new serial: lego's ECDSA certificate comes from an E or YE issuer,
  Traefik's RSA one from an R or YR issuer (YR2 in the rehearsal). If none comes within two
  minutes, put `$S/custom.json` back (the lego certificate is still valid) and look at Traefik's
  log.

Otherwise keep path A by hand: rerun the same `lego run` (it renews when about a third of the
lifetime is left), rebuild `$S/custom.yaml` and `$S/custom.json` and set them again, at least
every 60 days. Read the end date back during the soak (step 10).

Not done, an option: Traefik can be given a DNS-challenge resolver itself (Traefik environment
`TRAEFIK_CERTIFICATESRESOLVERS_<name>_ACME_DNSCHALLENGE_PROVIDER=cloudflare` with its email and
storage, plus `CF_DNS_API_TOKEN`, then a Traefik restart, and the domain's resolver field set to
`<name>`). Other domains keep their resolver, but the restart redeploys Traefik for every project
and rotates the dashboard token, and the DNS token then lives in Traefik's environment.

**Path B, issue** (not rehearsed; path A works). In Cloudflare, SSL/TLS, Origin Server, create an
RSA certificate for `feddit.com` and install its certificate and key the same way as path A (the
key is shown once; never store it in the repository). Save Cloudflare's Origin CA RSA root (from
Cloudflare's Origin CA documentation) as `$S/origin-ca-root.pem`. The token can list Origin CA
certificates; creating one was not tried.

**Both paths:** read the zone's SSL/TLS mode back as Full (strict) and record "Always Use HTTPS"
(the token cannot read either).

**Check, before step 6** (go or no-go item 9), from Andrew's machine, with `O` the new origin's
address (no firewall is on it yet; step 7 item 3 adds it). `CA` is empty for path A (the
system's roots) and Cloudflare's origin root for path B; never `-k`:

```sh
CA=''                                       # path B: CA=$S/origin-ca-root.pem
curl -sS ${CA:+--cacert $CA} --resolve feddit.com:443:$O -o /dev/null -w 'TLS ok, http %{http_code}\n' https://feddit.com/
echo | openssl s_client -connect $O:443 -servername feddit.com ${CA:+-CAfile $CA} 2>/dev/null |
  grep -E 'Verify return code|subject=|issuer='
```

`TLS ok` with any HTTP code passes (404 or 502 while `web` has no code): curl checked the chain
and the name feddit.com. A certificate error (curl exit 60, "SSL certificate problem", or a name
that does not match) or a handshake error (exit 35) is a no-go: the origin serves Traefik's
default certificate or the wrong one. `openssl` must print `Verify return code: 0 (ok)`, with a
Let's Encrypt issuer for path A or a CloudFlare Origin issuer for path B (an Origin CA
certificate's subject is not feddit.com; the name is in its alternative names, which curl
checked). Record the issuer and end date. The rehearsal had `TLS ok, http 404` before `web`
existed and `TLS ok, http 200` after, `Verify return code: 0 (ok)`, issuer Let's Encrypt YE1, end
date 2027-02-09 (that test certificate is revoked). Run these lines in `bash`: zsh, macOS's default
shell, passes `${CA:+--cacert $CA}` and a variable like `$R` (step 7 item 6) to curl as one
argument, and curl stops with "option ... is unknown".

**Browser for the sign-in, path A.** Andrew's usual browser with the hosts file line (secure DNS
off for that step, step 7 item 5). The rehearsal used an isolated Obscura session behind a local
proxy that sent only the test name to the origin: the sign-in page loaded with the certificate
checked, and a name the origin has no certificate for was refused.

**Path B only, the browser for the sign-in** (step 7 item 5), on Andrew's machine: a Firefox
profile of its own trusts the origin root, so his everyday browsers never do. It needs Firefox
installed; `certutil` is Homebrew's `nss`. The `user.js` line turns off Firefox's DNS over HTTPS in that profile, so it
reads the hosts file line:

```sh
P=$S/firefox-cutover && mkdir -m 700 $P
echo 'user_pref("network.trr.mode", 5);' > $P/user.js
certutil -N -d sql:$P --empty-password
certutil -A -d sql:$P -n 'Cloudflare Origin CA (cutover)' -t 'C,,' -i $S/origin-ca-root.pem
certutil -L -d sql:$P                       # lists the root with trust "C,,"
/Applications/Firefox.app/Contents/MacOS/firefox -no-remote -profile $P https://feddit.com/nodeinfo/2.1
```

Cleanup after step 7 item 6: quit that Firefox and `rm -rf $S/firefox-cutover`. The root was
trusted only inside that folder; nothing was added to the system keychain or another browser.

## Step 6: go-ahead and final archive (production; Andrew's named go-ahead)

This step changes production and runs only under Andrew's step 6 go-ahead. First put a
maintenance responder in front of PieFed, so peers and people get 503 with `Retry-After` for the
whole window instead of upstream errors from a dead origin; then stop PieFed but keep it
restorable (its database and volumes stay); then take the final archive.

1. **Maintenance responder.** The box's own Caddy (systemd `caddy`, config `/etc/caddy/Caddyfile`)
   terminates TLS for feddit.com and proxies to PieFed on `127.0.0.1:8030`. Confirm that first
   (`ssh feddit@box.feddit.com 'systemctl is-active caddy; systemctl cat caddy | grep ExecStart'`
   names `--config /etc/caddy/Caddyfile`; anything else, stop and adapt). The change replaces the
   `feddit.com` site block, and only it:

   ```diff
    feddit.com {
   -    reverse_proxy 127.0.0.1:8030
   +	header Retry-After 3600
   +	header Cache-Control no-store
   +	respond "feddit.com is moving to new software. Please try again in an hour." 503
    }
   ```

   Build it from the box's current file, check the diff is exactly that, then install and reload
   (`ssh -t` for the sudo prompts):

   ```sh
   ssh feddit@box.feddit.com 'cat /etc/caddy/Caddyfile' > $S/Caddyfile.piefed
   diff /Users/admin/Projects/feddit-archive/2026-11-08/Caddyfile $S/Caddyfile.piefed   # empty: as archived; otherwise stop and adapt
   perl -0pe 's/^feddit\.com \{\n\s*reverse_proxy 127\.0\.0\.1:8030\n\}\n/feddit.com {\n\theader Retry-After 3600\n\theader Cache-Control no-store\n\trespond "feddit.com is moving to new software. Please try again in an hour." 503\n}\n/m' \
     $S/Caddyfile.piefed > $S/Caddyfile.maintenance
   diff $S/Caddyfile.piefed $S/Caddyfile.maintenance        # only the three lines above
   scp $S/Caddyfile.maintenance feddit@box.feddit.com:Caddyfile.maintenance
   ssh -t feddit@box.feddit.com 'caddy validate --adapter caddyfile --config ~/Caddyfile.maintenance &&
     sudo cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.piefed &&
     sudo install -m 644 ~/Caddyfile.maintenance /etc/caddy/Caddyfile && sudo systemctl reload caddy'
   ```

   Check it through Cloudflare before going on. Every line must read `503` and `3600`:

   ```sh
   AP='Accept: application/activity+json'
   for p in / /inbox /actor /u/feddit-admin /nodeinfo/2.0; do
     curl -s -o /dev/null -H "$AP" -w "GET $p %{http_code} retry-after %header{retry-after}\n" https://feddit.com$p
   done
   curl -s -o /dev/null -X POST -H 'content-type: application/activity+json' -d '{}' \
     -w 'POST /inbox %{http_code} retry-after %header{retry-after}\n' https://feddit.com/inbox
   ```

   A Cloudflare error page, a `52x` or a missing `Retry-After` is a no-go: restore the file (rollback
   below) and look at Cloudflare's custom error rules first. The responder stays until the origin switch (step 7.8) has
   pointed Cloudflare at the new origin (and after that it serves nothing); the rollback removes it.

2. Stop PieFed and take the final dump (the database container keeps running):

   ```sh
   ssh feddit@box.feddit.com 'cd ~/pyfedi && docker compose stop web celery piefednotifs'
   ssh feddit@box.feddit.com 'cd ~/pyfedi && docker compose exec -T db sh -c "pg_dump -U \"\$POSTGRES_USER\" -Fc \"\$POSTGRES_DB\""' > $A/piefed-db.dump
   ```

   Run the checks of step 1 again: still `503` with `Retry-After: 3600`, now with PieFed stopped.

(`$A` a new dated archive folder, 700.) Restore it as in step 3, run `inventory` (still 0 local
posts), then `export --admin Andrew --out $S/bundle-final.json`. The 2026-11-08 dump is schema
`7c5a293ed40c` and the box has run 1.8.11 since (`61f3520d99b2`): re-run the archive tests
(`CUTOVER_ARCHIVE_DB_URL=... pnpm exec vitest run --project tools tools/cutover/src/archive.test.ts`)
against the final dump before exporting. Beyond the responder and the stopped services,
`box.feddit.com` is untouched: it is the rollback target.

## Step 7: production import and origin switch (production)

1. Production Easypanel project (decision 9) with `postgres` and a temporary `cutover` service,
   in the order of "On Easypanel" (step 4): migrate with `PUBLIC_ORIGIN` **unset**, set
   `delivery.enabled` (the federation switch) and `registration.enabled` off and also
   `inbox.enabled` off (so peers get 503 with `Retry-After`), all before the import, copy the
   bundle in, then in the `cutover` console
   (`PUBLIC_ORIGIN=https://feddit.com`):

   ```sh
   node tools/cutover/src/cli.ts import --bundle /tmp/cutover/bundle-final.json   # report: federation.deliveryEnabled false
   node tools/cutover/src/cli.ts verify --bundle /tmp/cutover/bundle-final.json
   psql "$DATABASE_URL" -Atc "select key, value from site_settings where key in ('delivery.enabled', 'inbox.enabled', 'registration.enabled') order by key"   # all false
   ```

2. Add `web` as in `README.md` with `PUBLIC_ORIGIN=https://feddit.com`, `BETTER_AUTH_SECRET`,
   `SMTP_URL`, `MAIL_FROM` and `PEBLISH_TRUSTED_PROXY=cloudflare`. `worker` (same source and
   environment as `web`, `PEBLISH_PROCESS=worker`) may be created now, with the federation switch
   still off: read `delivery.enabled` back as `false` first. Its jobs wait until step 8.

   The `web` domain serves the feddit.com certificate installed before step 6 ("TLS on the new
   origin", path A rehearsed 2026-11-11). Run that section's check again now that `web` runs; it must print
   `TLS ok, http 200`. Without it this step is a no-go.

3. **Origin firewall: Cloudflare only.** `PEBLISH_TRUSTED_PROXY=cloudflare` takes each client's
   address from `CF-Connecting-IP`, a header anyone reaching the origin directly can set, so from
   now on the origin takes ports 80 and 443 from Cloudflare's ranges only. On the production host,
   as root. Docker publishes Traefik's ports past `ufw`, so the rules go in Docker's `DOCKER-USER`
   chain, matched on the original port and on new connections arriving on the public interface
   (so the worker's own outgoing HTTPS is not touched). Check first that
   `docker ps --format '{{.Names}} {{.Ports}}' | grep -i traefik` shows `0.0.0.0:443->443/tcp`; if
   Traefik uses the host network instead, the same two rules go in `INPUT` with `--dport`.

   ```sh
   IF=$(ip route show default | awk '{print $5; exit}')
   ipset create origin-allow  hash:net family inet  -exist
   ipset create origin-allow6 hash:net family inet6 -exist
   for n in $(curl -s https://www.cloudflare.com/ips-v4); do ipset add origin-allow  "$n" -exist; done
   for n in $(curl -s https://www.cloudflare.com/ips-v6); do ipset add origin-allow6 "$n" -exist; done
   for port in 80 443; do
     iptables  -I DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport $port -m set ! --match-set origin-allow  src -j DROP
     ip6tables -I DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport $port -m set ! --match-set origin-allow6 src -j DROP
   done
   iptables -S DOCKER-USER; ip6tables -S DOCKER-USER; ipset list -t origin-allow   # read back
   ```

   Make the sets and rules survive a reboot (`netfilter-persistent save` with `ipset-persistent`
   installed). Cloudflare's ranges change rarely; re-read them before opening and monthly.

4. **Operator path for the pretest (temporary).** The sign-in and the pretest below go straight to
   the origin from Andrew's machine, which the firewall now refuses. Let his current public
   address in for this step only:

   ```sh
   ME=$(curl -s https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')   # on Andrew's machine
   ipset add origin-allow <ME> -exist       # on the host, as root, with that address (origin-allow6 for IPv6)
   ```

   and add `<O> feddit.com` to his machine's hosts file (`O` the new origin's address). A direct
   request carries no `CF-Connecting-IP`, so the app falls back to the connection's peer, which
   behind Easypanel is Traefik: every direct request shares Traefik's internal address as its
   client address, so throttles (sign-in, password reset, inbox key lookups) count all of them
   together, and the session list shows Traefik's address for this session. A direct client could
   also send its own `CF-Connecting-IP` and pick its key. Both are harmless while only Andrew's
   address is let in, and the reason the path closes in item 7.

5. Sign in, in a browser that trusts the origin's certificate: with path A his usual browser, with
   path B only the Firefox profile of "TLS on the new origin". First open
   `https://feddit.com/nodeinfo/2.1`: it must name `peblish`. The box's 503 page (step 6) means the
   browser went around the hosts file (turn its secure DNS off for this step); a certificate warning
   means the wrong browser or path: stop, never click through it. Then `Andrew` asks for a password
   reset at `/auth/reset`, sets a password, signs in and turns on two-factor at `/settings/security`
   in that same session. Admin pages need a session that passed two-factor (enrolled or verified in
   it), not only an account with it on; enrolling signs every other session out. `feddit-admin` does
   the same when needed. No account has an age declaration (NSFW stays hidden until each declares in
   settings). If a reset is refused as throttled, wait out the window (item 4: direct requests share
   one budget).
6. Host-header pretest against the new origin, from Andrew's machine. Its trust follows the
   certificate: normal trust for path A (the system's roots validate the Let's Encrypt chain), and
   `--cacert` with Cloudflare's origin root for path B (which cannot validate a Let's Encrypt
   chain). Never `-k`. Any `000` below is a failed connection or certificate: rerun that line with
   `-sS` in place of `-s` to see which, and stop. Run it in `bash`: zsh passes `$R` to curl as one
   argument, and curl stops with "option --resolve ... is unknown".

   ```sh
   R="--resolve feddit.com:443:$O"                                         # path A
   R="--resolve feddit.com:443:$O --cacert $S/origin-ca-root.pem"          # path B instead
   AP='Accept: application/activity+json'
   for p in /actor /u/feddit-admin /u/Andrew /c/announcements /c/microblogs; do curl -s $R -H "$AP" -o /dev/null -w "$p %{http_code}\n" https://feddit.com$p; done
   curl -s $R 'https://feddit.com/.well-known/webfinger?resource=acct:feddit-admin@feddit.com'
   curl -s $R https://feddit.com/nodeinfo/2.1        # usage.users.total 2, localPosts present
   curl -s $R -X POST -H 'content-type: application/activity+json' -d '{}' -o /dev/null -w '%{http_code}\n' https://feddit.com/inbox   # 401 or 503, never 410, 418 or another 5xx
   ```

7. **Close the operator path** before the switch: on the host `ipset del origin-allow <ME>`, and
   remove the hosts file line on Andrew's machine. Then check, from Andrew's machine, that a
   direct connection to ports 443 and 80 cannot be made and the set holds Cloudflare's ranges
   only. The check is on the connection, not on an answer: `-k` keeps a certificate from deciding
   it, and `%{exitcode}` (curl 7.75 or later) is curl's own result. With `O6` the origin's IPv6
   address, if it has one, run the two `curl` lines again with `[$O6]` in place of `$O`:

   ```sh
   W='exit %{exitcode}, http %{http_code}, connected %{time_connect}\n'
   curl -sk --connect-timeout 5 --max-time 15 --resolve feddit.com:443:$O -o /dev/null -w "443: $W" https://feddit.com/nodeinfo/2.1
   curl -s  --connect-timeout 5 --max-time 15 --resolve feddit.com:80:$O  -o /dev/null -w "80: $W" http://feddit.com/nodeinfo/2.1
   ipset test origin-allow <ME>             # on the host: "is NOT in set origin-allow"
   ```

   Each `curl` line passes only with `exit 7` (the connection was refused) or `exit 28` with
   `connected 0.000000` (no connection within 5 s, which is what the `DROP` rules give). Anything
   else is a no-go, because a TCP connection was made and the origin is reachable around
   Cloudflare: `exit 0` with any HTTP code, a TLS or certificate error (`exit 35`, `exit 60` or
   another), `exit 52` or `exit 56` (connected, then cut off), or `exit 28` with a non-zero
   `connected` time (connected, then slow). Look at the firewall rules (item 3) before going on.

   Rehearsed 2026-11-11 against `tls-1.peblish.com` on 38.102.126.114, with no firewall: the open
   ports fail as they should (443 `exit 0, http 401, connected 0.23`, 80
   `exit 0, http 301, connected 0.23`), and closed ports 8443, 4443 and 5432 (the same lines with
   `:<port>` in the `--resolve` and the URL) pass with `exit 7, http 000, connected 0.000000` in 0.24 s. That
   server drops no port, so the `DROP` shape was shown against 192.0.2.1, where nothing answers:
   `exit 28, http 000, connected 0.000000` after 5.0 s.

8. Switch the Cloudflare origin of feddit.com to the new origin in one step (the proxied DNS
   record). No cache rules on `/u`, `/c`, `/post` or any page; the one cache rule is
   `/media/proxy/*` ([edge-cache.md](edge-cache.md)), added only once the two edge variables are
   set on web and worker and the real-edge checklist in its section 3 has passed (until then, no
   cache rule at all). The WAF must not block `POST /inbox`. From here the box's responder
   (step 6) gets no traffic.

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

Before the first admin or invitee, repeat the step 7.7 `curl` lines from an address outside
Cloudflare and outside the set, with the same rule: each passes only on `exit 7`, or `exit 28`
with `connected 0.000000`; any HTTP code and any TLS or certificate error is a no-go. Read
`ipset list origin-allow` back: Cloudflare's ranges only, no operator address. Then admins first,
then invitees (cap about 25 for 30 days).

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

Before or during the soak: switch the Cloudflare origin of feddit.com back to `box.feddit.com`
(peers get the box's 503 with `Retry-After` meanwhile), start PieFed, and only then put PieFed's
Caddyfile back, so nothing answers 502 in between:

```sh
ssh feddit@box.feddit.com 'cd ~/pyfedi && docker compose up -d web celery piefednotifs'
ssh -t feddit@box.feddit.com 'sudo cp -p /etc/caddy/Caddyfile.piefed /etc/caddy/Caddyfile && sudo systemctl reload caddy'
curl -s -o /dev/null -w '%{http_code}\n' https://feddit.com/nodeinfo/2.0   # 200, PieFed again
```

The same two lines undo step 6 alone (PieFed started, then the Caddyfile restored) when the
cutover stops before the origin switch.

Content created on peblish after the switch is not carried back (small in week one). The peblish
project stays as it is for diagnosis; do not run its worker against feddit.com while PieFed serves
it again.
