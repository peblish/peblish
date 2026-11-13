# Backups: nightly dump and hourly ledger export to a bucket

A `backup` service in the Easypanel project takes a database dump every night and exports the
deletion ledger every hour, uploads each to a bucket of its own, checks it from the bucket and
records it as the last good one. Nobody has to be there. A restore fetches a backup and the newest
ledger export from the bucket and runs the existing `restore` or `drill`, which re-applies the
ledger (`deploy/cutover.md`, "Backups and the deletion ledger").

Andrew's decision (2026-11-11): production backups go to a Cloudflare R2 bucket with a 30-day
delete rule and a key limited to it. R2 is not on yet; the mechanism runs on staging against
MinIO (`/Users/admin/.agents/plans/feddit/staging.md`).

## What runs

The tool is `tools/cutover` (`tools/cutover/src/nightly.ts` and `bucket.ts`); the dump and the
ledger export are its existing `backup` and `ledger-export`.

| When (UTC)          | Object                                     | What                                                          |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| daily at 03:00      | `backups/<time>.dump`                      | `pg_dump -Fc` of `DATABASE_URL`                               |
| hourly at :05       | `ledger/<time>.json`                       | every `deletion_ledger` row (`peblish.ledger/1`)              |
| after each good run | `status/backup.json`, `status/ledger.json` | the last good run: object, size, SHA-256, start and end times |

`<time>` is UTC to the second, such as `20261113T030000Z`, so names sort by time.

Each run:

1. Takes a Postgres advisory lock for its kind on the source database (`peblish.backup.backup` or
   `peblish.backup.ledger`). If another run of that kind holds it (a second container during a
   redeploy, or a console run beside the schedule), the run is skipped and touches nothing.
2. Writes the dump or export into a new folder under `TMPDIR` (default `/tmp`), mode 700, the file
   mode 600.
3. Uploads it multipart, 16 MiB at a time: each part signed with its SHA-256 and sent with its MD5,
   so the bucket refuses a damaged part, and the whole file's SHA-256 stored as the object's
   `sha256` metadata. Until the upload completes no object exists; a failed upload is aborted.
4. Checks the object from the bucket: its size must equal the file's, and its ETag must equal the
   multipart ETag computed from the parts (R2 and MinIO give S3's form; a store that answers
   another form is checked by size only).
5. Only then writes the status record. The temporary folder is removed whatever the outcome.

A failed check after the upload completed tries to delete the object; a key without delete
permission leaves it, the log line says so, and the status record never names it, so a fetch
never takes it for the last good backup (and its `sha256` would not match).

Each run logs one line: outcome, object name, size, and duration, plus the row count for a
ledger export. Errors go through the tool's error rules (`tools/cutover/src/errors.ts`): the
bucket call, HTTP status and S3 error code, or a database error's code, never a credential, the
endpoint or a row.

```text
backup schedule started (UTC): dump daily at 03:00, ledger hourly at :05; last good backup backups/20261113T013501Z.dump at 2026-11-13T01:35:02.058Z, last good ledger ...
ledger ok: ledger/20261113T020500Z.json, 93 bytes, 0 rows, 0.1 s
backup ok: backups/20261114T030000Z.dump, 280697 bytes, 0.3 s
backup FAILED: backups/20261114T030000Z.dump after 0.4 s: start upload backups/20261114T030000Z.dump: 403 SignatureDoesNotMatch
```

## Why a service of its own and not the panel's scheduling

The Easypanel on 38.102.126.114 is 2.38.0. Its API (`/api/openapi.json`, read 2026-11-13) has no
scheduled jobs for an App service. Its own scheduled work is database backups
(`createDatabaseBackup`: a cron `schedule`, a `retention` count) and volume backups, both
uploading to a storage provider (`createS3Provider`). That does not fit:

- Storage providers are panel-wide, not per project, and `listStorageProviders` returns their
  connection settings, keys included, to any panel reader.
- It does only the dump: no ledger export, no check of the object from the bucket, no last good
  record.
- Its retention deletes old backups itself by count, where the decision is the bucket's 30-day
  rule.

So the schedule lives in a small long-running process from the cutover image. It survives a
redeploy and a restart because it keeps no state of its own: at start, and again just before a
run, it reads the last good run from the bucket. A run is due when no good run started at or after
its last slot (03:00 for the dump, :05 for the ledger), so a service that was down for three days
runs once when it comes back, not three times, and a redeploy that lands just after a run does not
repeat it. Kinds run independently, so a long dump does not hold the hourly export. A failed run
is retried 15 minutes later and each failure logs a line; a run never overlaps another of its
kind (the advisory lock). SIGTERM stops the schedule and any run in flight (the dump is killed,
the upload aborted, the files removed).

## Setting it up on Easypanel

In the project, beside `web` and `worker`:

1. Create an App service `backup`, in one call or in this order before its source exists: build
   type Dockerfile, file `tools/cutover/Dockerfile`; deploy command
   `exec node tools/cutover/src/cli.ts backup-schedule` (Easypanel runs the command through
   `sh -c`; `exec` makes Node the container's first process, so SIGTERM reaches it); one replica;
   no domain, no port. Set the environment below.
2. Upload the same source archive as `web` (staging) or point it at the same Git source. The
   upload deploys it.
3. The log shows `backup schedule started ...` and, on a bucket with no status records yet, a
   ledger export and a dump straight away.

| Variable                                                 | Value                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                           | the same as `web`'s                                                                     |
| `BACKUP_S3_ENDPOINT`                                     | the bucket's S3 API: `https://<account id>.r2.cloudflarestorage.com` for R2             |
| `BACKUP_S3_BUCKET`                                       | the backup bucket, never the media bucket                                               |
| `BACKUP_S3_REGION`                                       | `auto` for R2, `us-east-1` for MinIO                                                    |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | the key limited to the backup bucket                                                    |
| `S3_BUCKET`                                              | the media bucket's name, required: the run refuses a backup bucket equal to it          |
| `S3_ACCESS_KEY_ID`                                       | optional, the media key's id: the run then also refuses the media key as the backup key |

Give the service at least 768 MB of memory and free disk in the container for one dump (below).
The database user needs to read every table; staging uses `web`'s. A read-only role would do for
the dump and the export; the drill needs one that may create a database.

## Knowing it ran

The signal is the status records in the bucket, which only a good, checked run writes. In the
`backup` console:

```sh
node tools/cutover/src/cli.ts backup-status   # exit 0 when both are fresh, 1 when one is stale or missing
```

```text
backup: backups/20261113T013501Z.dump, 280697 bytes, finished 2026-11-13T01:35:02.058Z (0 min ago)
ledger: ledger/20261113T013504Z.json, 93 bytes, finished 2026-11-13T01:35:05.032Z (0 min ago)
```

What goes stale when it stops: the backup record after 26 hours, the ledger record after 2 hours
(one interval and some slack). A stopped or crashing service, a database it cannot reach, a
bucket that refuses it and a check that fails all leave the records as they were, so the age
grows; the service log has a `FAILED` line per attempt. With `--json` the same report is
machine-readable. The records are the last good run, not proof the service is up: a service that
is up and failing shows only in its log and in the age.

Proposal, not built: an outside check that pages someone. The smallest is a dead man's switch (a
service such as Healthchecks, pinged after each good run, alerting when pings stop); it needs an
account and a URL, Andrew's decision. Until then, check `backup-status` with the weekly checks.

## Retention: the bucket's lifecycle rule

The tool never deletes old backups. The bucket does: every object expires 30 days after it was
written. The status records are rewritten on every good run, so they never expire while backups
run; once the service has been failing for 30 days, the bucket is empty and `backup-status` says
none. That is the price of an age rule, and the reason to watch the age.

### R2 (production; waits on Andrew, R2 is not on)

R2 is off on the account: the Cloudflare token answers 403 for R2 (staging.md). When Andrew turns
R2 on:

1. Cloudflare dashboard, R2, Create bucket: name `peblish-backups`, location automatic (or the
   hint nearest the server), default storage class Standard. Public access stays off (no
   `r2.dev` URL, no custom domain).
2. The bucket, Settings, Object lifecycle rules, Add rule: name `expire-30-days`, applies to all
   objects, "Delete uploaded objects" after 30 days, and "Abort incomplete multipart uploads"
   after 1 day (a run killed mid-upload leaves parts that are not objects).
3. R2, Manage R2 API Tokens, Create API token: name `peblish-backup`, permission "Object Read &
   Write", "Apply to specific buckets only" with `peblish-backups` only, TTL forever (or a date to
   rotate). Copy the access key id and secret into the production env file, never into a chat.
   R2's token permissions are per bucket and cannot leave out delete; a stolen key can delete
   backups. An R2 bucket lock rule (the bucket's Settings, Bucket lock rules) on the prefixes
   `backups/` and `ledger/` for 30 days would stop that; open decision below.
4. The endpoint is `https://<account id>.r2.cloudflarestorage.com`, region `auto`. Set the
   variables on the production `backup` service and deploy it.
5. Check: in its console `node tools/cutover/src/cli.ts backup-run ledger` (exit 0, an `ok` line),
   then `backup-status`, then the restore drill below once.

### MinIO (staging)

Done on staging 2026-11-13 in the `minio` console (MinIO RELEASE.2026-08-04):

```sh
mc mb local/peblish-staging-backups
mc admin policy create local peblish-staging-backup-rw policy.json   # list the bucket and its uploads; get, put, abort and list parts of its objects; no delete
mc admin user add local <key id> <secret>
mc admin policy attach local peblish-staging-backup-rw --user <key id>
mc ilm rule add --expire-days 30 local/peblish-staging-backups
```

MinIO's lifecycle rules have no abort of incomplete uploads; MinIO itself removes uploads older
than `stale_uploads_expiry` (24 hours, read from `mc admin config get local api`).

## Restore from the bucket

In the `backup` console (it has the bucket key and Postgres 17 client tools):

```sh
cd /app
node tools/cutover/src/cli.ts backup-fetch --dir /tmp/cutover/fetch [--object backups/<time>.dump]
```

It downloads the backup named, or the last good one from `status/backup.json`, and the newest
ledger export, into a mode 700 folder as mode 600 files, checks each against its size and `sha256`
record (a file that does not match is removed), and prints the two paths. Then either:

```sh
# The drill on the fetched files: restore into a new drill_<time>_<random>, re-apply, compare counts, drop it.
node tools/cutover/src/cli.ts drill --db "$DATABASE_URL" --dir /tmp/cutover/drill --backup <backup file> --ledger <ledger file>
# A real restore into a NEW database, then point the services at it (deploy/cutover.md).
node tools/cutover/src/cli.ts restore --backup <backup file> --db <new database url> --ledger <ledger file>
rm -rf /tmp/cutover/fetch /tmp/cutover/drill
```

The drill's counts differ where the database changed since that backup; on a quiet database they
match. If the damaged database still answers, run `backup-run ledger` first so the newest ledger
export is current.

## Size

The upload holds one 16 MiB part in memory at a time. S3, R2 and MinIO allow 10,000 parts, so the
largest object is 156.25 GiB; every part but the last is the same size, as R2 requires. Multipart
rather than one PUT because a single PUT tops out at 5 GiB on S3 and R2 and could not be checked
part by part.

Tested (2026-11-13, a MacBook, the dev MinIO):

- In the test suite: an 11 MiB file with 5 MiB parts (3 parts), checked by size and multipart
  ETag and fetched back with a matching SHA-256.
- By hand, random files with the default 16 MiB parts: 256 MiB (16 parts) and 2 GiB (128 parts).
  2 GiB uploaded in 14 to 15 s and fetched back in 10 s, SHA-256 matching. Peak memory was 480 to
  520 MB for both sizes (130 MB at start): it does not grow with the file.
- On staging: the real dump, 280,697 bytes, one part.

Disk: a run needs room for one dump (or export) in `TMPDIR` until it is uploaded; a fetch for a
restore needs room for the backup and the export.

## Encryption

A dump holds password hashes, email addresses, two-factor secrets (encrypted with
`BETTER_AUTH_SECRET`) and the actors' private keys. As designed, what protects it in R2:

- The bucket is private (no public access, no `r2.dev` URL) and only the backup key and the
  account can read it.
- The key is limited to that one bucket, held only by the `backup` service and the env file.
- R2 encrypts every object at rest (AES-256) and serves the S3 API over TLS only.

What that does not cover: anyone with the backup key, the Cloudflare account, or a fetched copy
reads everything. Client-side encryption would close that: `pg_dump | age -r <public key>` before
the upload, with the private key kept offline by Andrew (password manager and paper) and used
only for a restore. `age` is in Debian bookworm, so it is a few lines in the image and the run.
It is not built: the cost is key custody, since losing that private key loses every backup, and
the restore would need it on the server. Recommendation: add it before outside users' data is in
production, with a restore drill that uses the offline key once. Open decision for Andrew.
