# Deploying peblish on Easypanel

Nothing in this repository deploys anything. This is the shape of a peblish Easypanel
project: first the private staging project on a peblish.com subdomain (plan, cutover step
2), later production as a separate project (decision 9). Never point either at feddit.com
or lab.feddit.com before the cutover gate.

## Services

One Docker image (the root `Dockerfile`) runs three processes, chosen by command.

| Service    | Easypanel type               | Source                                                                           | Command               | Port, domain                                                         | Health check                    |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `postgres` | Postgres service, version 17 | Easypanel template                                                               |                       | internal only                                                        | built in                        |
| `web`      | App                          | Git `github.com/peblish/peblish`, branch `main`, build type Dockerfile, path `/` | `web` (image default) | container port 3000, domain such as `staging.peblish.com` with HTTPS | HTTP GET `/healthz`, expect 200 |
| `worker`   | App                          | same source and image as `web`                                                   | `worker`              | no port, no domain                                                   | none (restart policy)           |

The image's Docker `HEALTHCHECK` (`deploy/healthcheck.mjs`) probes `/healthz` only when the
container runs `web`. For `worker` and `migrate` it reports healthy without probing anything:
the worker's liveness is its process (set a restart policy), and `migrate` is a one-shot run
that exits. Override it per service where the platform supports that, for example
`healthcheck: { disable: true }` in compose or `--no-healthcheck` on `docker run`.

Migrations run as a one-off before `web` and `worker` move to a new build: open the `web`
service console and run `peblish migrate` (or run the image with command `migrate` once).
It applies pending migrations and, on the first run, creates the local instance row from
`PUBLIC_ORIGIN`. Run one replica of `web` and one of `worker` until a later lane adds
leader election; consumers already lock their cursors, so a second worker is safe but
idle.

## Environment

| Variable            | Services                       | Value                                                                                                                             |
| ------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | web, worker, migrate           | `postgres://<user>:<password>@<project>_postgres:5432/<db>` (Easypanel's internal host)                                           |
| `PUBLIC_ORIGIN`     | migrate (later web and worker) | `https://staging.peblish.com`. Fixed at the first migrate: every local ap_id embeds it, and migrate refuses a different one later |
| `PORT`, `HOST`      | web                            | `3000`, `0.0.0.0` (image defaults)                                                                                                |
| `DATABASE_POOL_MAX` | web, worker                    | connections per pool, default 10 (each process has a read pool and a write pool)                                                  |
| `NODE_ENV`          | all                            | `production` (image default)                                                                                                      |

Added by later lanes (names reserved here so environments stay consistent):
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (lane A), `SMTP_URL` or the transactional mail
provider's API key (lane A; a sandbox sender on staging), `S3_ENDPOINT`, `S3_BUCKET`,
`S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (lane B2; Cloudflare R2 in
production, a separate bucket for staging).

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
  -e PUBLIC_ORIGIN=https://g0.peblish.test peblish:local migrate
docker run -d --name peblish-web --network peblish-dev_default -p 127.0.0.1:18300:3000 \
  -e DATABASE_URL=postgres://peblish:peblish@postgres:5432/peblish_g0 peblish:local
curl http://127.0.0.1:18300/healthz
BASE_URL=http://127.0.0.1:18300 pnpm e2e
```
