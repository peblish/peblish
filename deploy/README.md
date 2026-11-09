# Deploying peblish on Easypanel

Nothing in this repository deploys anything. This is the shape of a peblish Easypanel
project: first the private staging project on a peblish.com subdomain (plan, cutover step
2), later production as a separate project (decision 9). Never point either at feddit.com
or lab.feddit.com before the cutover gate.

## Services

One Docker image (the root `Dockerfile`) runs three processes, chosen by the `PEBLISH_PROCESS`
environment variable (`web` by default, `worker`, `migrate`). A command argument may repeat it
(`peblish worker`) but must agree, or the entrypoint exits 64: the healthcheck reads the variable.

| Service    | Easypanel type               | Source                                                                           | PEBLISH_PROCESS       | Port, domain                                                         | Health check                    |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `postgres` | Postgres service, version 17 | Easypanel template                                                               |                       | internal only                                                        | built in                        |
| `web`      | App                          | Git `github.com/peblish/peblish`, branch `main`, build type Dockerfile, path `/` | `web` (image default) | container port 3000, domain such as `staging.peblish.com` with HTTPS | HTTP GET `/healthz`, expect 200 |
| `worker`   | App                          | same source and image as `web`                                                   | `worker`              | no port, no domain                                                   | none (restart policy)           |

The image's Docker `HEALTHCHECK` (`deploy/healthcheck.mjs`) goes by `PEBLISH_PROCESS`. For `web`
it requires `/healthz` to answer 200 within 4 s. For `worker` it passes without a probe: the
worker serves no HTTP, so its liveness is the process (set a restart policy), and a stalled
outbox shows in the worker's lag warning. For `migrate` it passes too, since that is a one-shot
run that exits. Any other value, or none, fails, so a misconfigured container shows as
unhealthy. Disable it per service where the platform's own check replaces it, for example
`healthcheck: { disable: true }` in compose or `--no-healthcheck` on `docker run`.

Migrations run as a one-off before `web` and `worker` move to a new build: open the `web`
service console and run `PEBLISH_PROCESS=migrate peblish` (or run the image once with
`PEBLISH_PROCESS=migrate`).
It applies pending migrations and, on the first run, creates the local instance row from
`PUBLIC_ORIGIN`. Run one replica of `web` and one of `worker` until a later lane adds
leader election; consumers already lock their cursors, so a second worker is safe but
idle. The composer keeps a refused no-JavaScript submission's typed words in a flash held in
the web process's memory (10 minutes, a few per person); a second web replica, or a restart,
loses the kept values for that one redisplay (the post is not lost, only the words typed into
the refused form).

## Environment

| Variable                                   | Services                       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                             | web, worker, migrate           | `postgres://<user>:<password>@<project>_postgres:5432/<db>` (Easypanel's internal host)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PUBLIC_ORIGIN`                            | migrate (later web and worker) | `https://staging.peblish.com`. Fixed at the first migrate: every local ap_id embeds it, and migrate refuses a different one later                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PORT`, `HOST`                             | web                            | `3000`, `0.0.0.0` (image defaults)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DATABASE_POOL_MAX`                        | web, worker                    | connections per pool, default 10 (each process has a read pool and a write pool)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NODE_ENV`                                 | all                            | `production` (image default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PEBLISH_PROCESS`                          | all                            | `web` (image default), `worker` or `migrate`: which process starts, and what the healthcheck probes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BETTER_AUTH_SECRET`                       | web, the first-admin script    | Required: a random value of 32 characters or more, such as `openssl rand -base64 48`. Only `localhost` and `*.test` origins fall back to a development secret. Keep it stable: sessions are signed and stored two-factor secrets encrypted with it, so a new value signs everyone out, breaks every two-factor setup and voids every invite code not yet used. It also keys the remote-media proxy URLs (each proxied image URL is signed with a key derived from it), so a new value changes the proxy URLs in pages rendered afterwards and nothing stored; a web process that renders Markdown needs it set |
| `SMTP_URL`                                 | web                            | Required for mail (email verification, password reset): `smtp://host:port` or `smtps://user:password@host`. Without it, asking for a verification link again shows a mail error, while the link sent at sign-up and reset mail (sent in the background, so the form answers the same whether or not an account uses the address) fail only into the web log. A sandbox sender on staging                                                                                                                                                                                                                       |
| `MAIL_FROM`                                | web                            | Optional sender; default `<host> <no-reply@<host>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PEBLISH_TRUSTED_PROXY`                    | web                            | Where the client's address comes from, for throttling (the inbox's key lookup limits too) and the session list. `none` (default): the connection's peer; behind a proxy that is the proxy, so every client would share one budget. `traefik` (Easypanel): the last `X-Forwarded-For` entry, the peer Traefik saw. `cloudflare`: `CF-Connecting-IP`, only when the origin takes traffic from Cloudflare alone, since anyone reaching it directly can set that header                                                                                                                                            |
| `S3_ENDPOINT`                              | web                            | The object store's S3 API, such as `https://<account>.r2.cloudflarestorage.com` for Cloudflare R2. Path-style addressing (`<endpoint>/<bucket>/<key>`), which R2 and MinIO both take. Read by `packages/core/src/storage/s3.ts` and checked when first used, not at start: uploads are off (`uploads.enabled` is false) until image scanning is live, so a web process that never stores an image never reads the `S3_*` variables                                                                                                                                                                             |
| `S3_BUCKET`                                | web                            | The bucket. It must exist in production; the adapter creates a missing one only in development and tests. A separate bucket for staging                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `S3_REGION`                                | web                            | `auto` for R2 (`us-east-1` for MinIO)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | web                            | A key limited to the bucket (object read, write and delete)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ARACHNID_USERNAME`, `ARACHNID_PASSWORD`   | web, worker                    | Project Arachnid Shield credentials for image scanning (lane SAFE, `packages/core/src/mediascan/`): both or neither. With neither and `MEDIASCAN_LOCAL_ONLY` unset, every upload scan fails closed (`media.scan_unavailable`). The auth scheme and the `match_type` field are assumptions to confirm on the account's API page when it is registered                                                                                                                                                                                                                                                           |
| `ARACHNID_BASE_URL`                        | web, worker                    | Optional; default `https://shield.projectarachnid.com`. https only (`http:` is accepted on a loopback address), and no credentials in the URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MEDIASCAN_LOCAL_ONLY`                     | web, worker                    | `1`: scan against the local hash list only and call no provider (development and tests). Leave it unset in production, so scanning fails closed without a provider                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MEDIASCAN_TIMEOUT_MS`                     | web, worker                    | Optional; default `8000`: one deadline for the whole inline scan of an upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MEDIASCAN_UNDECIDED_PURGE_DAYS`           | web, worker                    | Optional; default `7`: days a quarantined image waits for an admin's decision before it is blocked and its bytes purged (a hold in force stops it)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Auth needs no base URL variable: links, cookies and the issuer follow the origin migrate
stored from `PUBLIC_ORIGIN`.

Sign-in and the other password and mail forms are throttled in Postgres (table `throttles`,
shared by every web process; `packages/core/src/identity/throttle.ts`), in fixed windows.
Beta budgets: sign-in, 10 failed attempts per client address and 5 per account in 15
minutes; typing the password again while signed in (to change it, turn two-factor on or off,
or delete the account), the same; reset mail, 3 per address typed and 10 per client address
an hour; invite codes that match no invite, 10 per client address an hour; another
verification link, one a minute per account; link previews (the server fetches an address a
person typed), 30 per client address and 20 per account in ten minutes; comments, 30 per
account in ten minutes (`comment`); looking up a remote handle or address, 20 per client
address and 10 per account in ten minutes (`resolve`); reports, 60 per client address and 30
per account in ten minutes (`report`). A refused attempt counts too, and an IPv6
client is counted by its /64. On Easypanel, staging and production alike, set
`PEBLISH_TRUSTED_PROXY=traefik` on `web` before going live; left at `none`, every client
shares the proxy's budgets per address. With Cloudflare proxying in front of Traefik, the
address Traefik saw is a Cloudflare edge, so budgets per address then apply per edge until
the origin takes traffic from Cloudflare alone and the setting moves to `cloudflare`.

No variable turns image uploads on: the `uploads.enabled` site setting does, and it stays false
until Project Arachnid has approved the account and an NCMEC test report exists. The worker runs
the scanning backstop `mediascan.scan_pending` (every 5 seconds: uploads the inline scan did not
finish) and `evidence.purge` (every minute: deletes the stored bytes of blocked and failed
images once their evidence allows it); both read the `S3_*` variables, so the worker needs them
once uploads are on.

The worker's `remote.prune` job (hourly) deletes what federation no longer needs, 2,000 rows
a transaction and 25 transactions a run: settled `inbox_raw` rows after 14 days, settled
`deliveries` after 30, `inbox_dedupe` after 90 days and ended `throttles` windows after one
day. A pending row is never deleted. The inbox's request limits and the fetch politeness gaps
are counted in memory per process.

## The first admin

After the first migrate, create the instance's site admin with the bundled script
`/app/processes/admin.mjs` (source `packages/core/src/identity/admin-cli.ts`). It reads the
password (12 to 128 characters) from stdin, so it stays out of the process list. In the `web`
service console, where `DATABASE_URL` and `BETTER_AUTH_SECRET` are already set:

```sh
printf '%s' "$ADMIN_PASSWORD" | node /app/processes/admin.mjs <name> <email>
```

Or as a one-off container (the entrypoint runs any command other than web, worker and migrate as given):

```sh
printf '%s' "$ADMIN_PASSWORD" | docker run -i --rm -e DATABASE_URL=... -e BETTER_AUTH_SECRET=... \
  peblish:<tag> node /app/processes/admin.mjs <name> <email>
```

It refuses once an admin exists (`admin.exists`). It marks the email verified and records the
16+ declaration. Then sign in and turn on two-factor at `/settings/security`: every admin
action refuses an admin without it.

## Health and federation endpoints

- `/healthz` is liveness: the process answers, without touching the database, so a
  database outage never restarts the app. Use it as Easypanel's health check.
- `/readyz` is readiness: 200 when the database answers, else 503 with `Retry-After`.
- Federation endpoints (lane FED-A) must never answer 410, 418 or other 5xx on inbox,
  actor, WebFinger or NodeInfo URLs; maintenance answers 503 with `Retry-After`.
- Cloudflare in front: no cache rules on `/u`, `/c`, `/post`; the WAF must not block
  `POST /inbox`; forward real client IPs.
- Compression: the Node server sends responses as they are and nothing in this repository
  compresses them. Traefik (Easypanel) and Cloudflare compress text in production, so turn it
  on at whichever of them faces the browser. The payload budget (`e2e/payload`, run by
  `pnpm e2e`) gzips every text file itself and measures those compressible bytes (woff2 fonts
  as sent); it does not measure what the Node server alone transfers.
- Remote images reach viewers through `/media/proxy/*`, which answers `Cache-Control: private,
max-age=600`. Cloudflare does not cache a `private` answer, so no cache rule is needed (or
  wanted) for it during the beta; every viewer's browser keeps an image for ten minutes.

## Transactions and the outbox

The worker hands consumers only events below the oldest open write transaction on the
Postgres cluster, so one long transaction delays every consumer. Keep write transactions
short, make no network calls inside them, and do not leave a psql session idle in a
transaction against production. The worker logs a warning naming the transaction (pid,
database, application, state) when that horizon lags more than 30 seconds.

## Checking an image locally

```sh
docker build -t peblish:local .
docker compose up -d --wait postgres
docker run --rm --network peblish-dev_default \
  -e DATABASE_URL=postgres://peblish:peblish@postgres:5432/peblish_g0 \
  -e PUBLIC_ORIGIN=https://g0.peblish.test -e PEBLISH_PROCESS=migrate peblish:local
docker run -d --name peblish-web --network peblish-dev_default -p 127.0.0.1:18300:3000 \
  -e DATABASE_URL=postgres://peblish:peblish@postgres:5432/peblish_g0 peblish:local
curl http://127.0.0.1:18300/healthz
BASE_URL=http://127.0.0.1:18300 pnpm e2e   # needs no DATABASE_URL; the lifecycle specs skip
```
