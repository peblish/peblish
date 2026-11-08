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
idle.

## Environment

| Variable             | Services                       | Value                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | web, worker, migrate           | `postgres://<user>:<password>@<project>_postgres:5432/<db>` (Easypanel's internal host)                                                                                                                                                                                                                                                                               |
| `PUBLIC_ORIGIN`      | migrate (later web and worker) | `https://staging.peblish.com`. Fixed at the first migrate: every local ap_id embeds it, and migrate refuses a different one later                                                                                                                                                                                                                                     |
| `PORT`, `HOST`       | web                            | `3000`, `0.0.0.0` (image defaults)                                                                                                                                                                                                                                                                                                                                    |
| `DATABASE_POOL_MAX`  | web, worker                    | connections per pool, default 10 (each process has a read pool and a write pool)                                                                                                                                                                                                                                                                                      |
| `NODE_ENV`           | all                            | `production` (image default)                                                                                                                                                                                                                                                                                                                                          |
| `PEBLISH_PROCESS`    | all                            | `web` (image default), `worker` or `migrate`: which process starts, and what the healthcheck probes                                                                                                                                                                                                                                                                   |
| `BETTER_AUTH_SECRET` | web, the first-admin script    | Required: a random value of 32 characters or more, such as `openssl rand -base64 48`. Only `localhost` and `*.test` origins fall back to a development secret. Keep it stable: sessions are signed and stored two-factor secrets encrypted with it, so a new value signs everyone out and breaks every two-factor setup                                               |
| `SMTP_URL`           | web                            | Required for mail (email verification, password reset): `smtp://host:port` or `smtps://user:password@host`. Without it, sending a verification link again shows a mail error; reset mail goes out in the background (the form answers the same whether or not an account uses the address), so a failure there only shows in the web log. A sandbox sender on staging |
| `MAIL_FROM`          | web                            | Optional sender; default `<host> <no-reply@<host>>`                                                                                                                                                                                                                                                                                                                   |

Auth needs no base URL variable: links, cookies and the issuer follow the origin migrate
stored from `PUBLIC_ORIGIN`.

Added by later lanes (names reserved here so environments stay consistent): `S3_ENDPOINT`,
`S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (lane B2; Cloudflare R2
in production, a separate bucket for staging).

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
