# Backups: nightly dump and hourly ledger export to a bucket

A `backup` service in the Easypanel project takes a database dump every night and exports the
deletion ledger every hour, uploads each to a bucket of its own, reads it back from the bucket and
records it as the last good one. Nobody has to be there; a backup that is overdue mails the
operator. A restore fetches the last good backup and ledger export from the bucket and runs the
existing `restore` or `drill`, which re-applies the ledger (`deploy/cutover.md`, "Backups and the
deletion ledger").

Andrew's decisions: production backups go to a Cloudflare R2 bucket with a 30-day delete rule, a
30-day bucket lock on `backups/` and `ledger/`, and a key limited to it (2026-11-11 and
2026-11-13). R2 is not on yet; the mechanism runs on staging against MinIO
(`/Users/admin/.agents/plans/feddit/staging.md`).

## What runs

The tool is `tools/cutover` (`tools/cutover/src/nightly.ts`, `bucket.ts`, `alerts.ts`); the dump and
the ledger export are its existing `backup` and `ledger-export`.

| When (UTC)          | Object                                     | What                                                                 |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| daily at 16:00      | `backups/<time>.dump`                      | `pg_dump -Fc` of `DATABASE_URL` (16:00 UTC is about 03:00 in Sydney) |
| hourly at :05       | `ledger/<time>.json`                       | every `deletion_ledger` row (`peblish.ledger/1`), streamed           |
| after each good run | `status/backup.json`, `status/ledger.json` | the last good run: object, size, SHA-256, ETag, start and end times  |

`<time>` is UTC to the millisecond in ISO 8601's basic form, such as `20261113T160000.123Z`, so
names sort by time. Two runs of a kind cannot overlap (the lock below), so they do not share a
name; if a name exists anyway, the upload is refused, early by a HEAD and finally by the store
itself (the completion carries `If-None-Match: *`), never overwritten. On a store that ignores
conditions (below) only the HEAD check stands, which a writer between the HEAD and the completion
would get past.

Each run:

1. Takes a Postgres advisory lock for its kind on the source database, on a session reserved for
   the run with no lifetime limit (getting it has 60 seconds). If another run of that kind holds
   it (a second container during a redeploy, or a console run beside the schedule), the run is
   skipped and touches nothing. If the session ends during the run, the run stops and fails.
   The first thing it does holding the lock, before any bucket read that might fail, is remove
   what killed runs left (step 2). Then it reads the current status record: one dated in the
   future ends the run as `superseded` straight away (below), with no dump.
2. Writes the dump or export into a new folder in the tool's own temporary root,
   `<TMPDIR>/peblish-backup` (default `/tmp/peblish-backup`), the file mode 600. The root is made
   mode 700, and the run refuses to write when it is not a folder of this user with mode 700 (a
   link, or someone else's). Folders are named `<kind>-<scope>-<random>`, where the scope is the
   first 12 hex digits of a SHA-256 of the database's host, port and name (never the password; the
   user only when the URL names no database, as Postgres then takes the user's name for it),
   because the advisory lock is per database. The cleanup removes only folders of its own kind and
   scope: the lock means no other run of those can be using them, so they are what a killed process
   left, while a service backing up another database through the same root keeps its folders. A
   table lock held for more than a minute fails the dump (`--lock-wait-timeout`) or the export
   (`lock_timeout`); the dump has 3 hours and the export 10 minutes in all.
3. Hashes the file, then uploads it multipart, 16 MiB at a time: each part signed with its SHA-256
   and sent with its MD5, so the bucket refuses a damaged part, and the whole file's SHA-256 stored
   as the object's `sha256` metadata. Until the upload completes no object exists; a failed upload
   is aborted (a request of its own, at most 5 seconds; the lifecycle rule clears what that
   misses).
4. Checks the object: its size, S3's multipart ETag where the store gives that form, and its bytes,
   read back from the bucket, against the file's SHA-256. A run is never recorded good on its size
   alone.
5. Publishes the status record, fenced (below). The temporary folder is removed whatever the
   outcome, including a stop by SIGTERM or SIGINT (a stop ends the lock waits at once, so the
   removal comes before the process exits), and the lock is let go (at most 10 seconds; ending the
   session releases it). A process killed outright (SIGKILL, out of memory, a crash) cannot remove
   it: the plaintext dump stays in the container until the next run of that kind removes it, or
   the container is replaced.

Every wait in a run is bounded, so a run always ends, as `ok`, `FAILED`, `skipped` or
`superseded`: the lock (60 s to get, 30 s for the final check, 10 s to let go), the dump (3 hours)
or the export (10 minutes), and each transfer (below). A run that cannot finish within its bounds
is a failed run, retried 15 minutes later.

### Publishing the status record

The record is the truth about the last good run, so only one run may write it, and never an older
one over a newer one. Before writing, the run asks Postgres whether it still holds its lock (a
check that does not answer within 30 seconds counts as lost: the run fails and records nothing).
It then reads the current record and its ETag. If that record is of a run that started at or after
this one, this run is `superseded`. Otherwise it writes its record conditionally: `If-Match` on the
ETag it read, or `If-None-Match: *` when there was none. If the store refuses (another writer
changed the record in between, for example a run that took the lock after this run's session
died), this run is `superseded` too. Superseded is neither a failure nor a success: it mails
nothing, and its uploaded object stays unrecorded until the lifecycle rule removes it. A one-shot
`backup-run` exits 0 for `ok`, 1 for `FAILED`, and 75 both for `skipped` (another run holds the
lock) and for `superseded`.

Two more cases fail closed:

- A record that comes back without an ETag cannot be replaced with `If-Match`, and `If-None-Match:
*` would be refused for ever, so the run fails with `the bucket returned status/<kind>.json
without an ETag, so it cannot be replaced safely`. No S3 store tested does this; it would be a
  proxy in between dropping the header.
- A run whose finish is before its start (the clock went back during it) fails with `the clock went
back during the run; nothing is recorded`.

A record dated more than five minutes in the future (a clock that was ahead when it was written)
is never written over: every run of that kind ends `superseded: ... the recorded run is dated in
the future; repair the record by hand (deploy/backups.md)`, and the kind goes overdue. To repair it,
check the service's clock (`date -u` in the console), then delete that one record: in the R2
dashboard, the bucket's `status/<kind>.json`; on staging, `mc rm <alias>/<bucket>/status/<kind>.json`
in the `minio` console. The service itself never deletes. On staging its MinIO key cannot (the
policy grants no delete); in production the R2 token can (R2 tokens cannot leave delete out), so a
holder of that key can delete or rewrite anything under `status/`, which is outside the bucket
lock, but not under `backups/` or `ledger/`. The next run (within 15 minutes, or a
`backup-run` in the console) finds no record and writes a fresh one.

Conditional writes, checked 2026-11-13:

- R2: its S3 API table (developers.cloudflare.com/r2/api/s3/api/, updated 2026-11-10) lists
  `If-Match` and `If-None-Match` on PutObject and on CompleteMultipartUpload, evaluated atomically
  against the committed bucket state; on CreateMultipartUpload they are not kept for the
  completion, so the tool puts them on the completion. Not tested against R2 (it is off).
- MinIO RELEASE.2026-08-04 (the dev and staging MinIO), tested: PUT with `If-None-Match: *` over an
  existing key answers 412, with a stale `If-Match` 412 and with the current one 200; `If-Match` on
  a missing key answers 404 (the tool treats it as refused); a completion with `If-None-Match: *`
  over an existing key answers 412 and keeps the old object.

At start the schedule probes `status/conditional-probe.json`: it writes it twice with
`If-None-Match: *` and expects the second to be refused, then writes it with `If-Match` on a wrong
ETag (refused) and on the current one (taken). On a store that fails any of these it logs `the
backup bucket ignores conditional writes ...`; there the fence is only the lock check and the
newer-start check, which does not stop a run whose session died just after its check from
overwriting a newer record with its own, older one.

The service never deletes and never overwrites anything under `backups/` or `ledger/` (the R2
bucket lock would refuse it anyway). An upload that fails its check, or a superseded run's, stays
in the bucket under its time name until the lifecycle rule removes it, but no status record names
it, so neither a restore nor `backup-status` takes it for good. Only `status/` is ever rewritten.

Each run logs one line: outcome, object name, size, and duration, plus the row count for a
ledger export. Errors go through the tool's error rules (`tools/cutover/src/errors.ts`): the
bucket call, HTTP status and S3 error code, a database error's code, or a fixed phrase (`timed
out`, `stopped`, `lost its database lock`); never a credential, the endpoint, a connection string
or a row. Anything that escapes is caught at the process level and printed the same way.
A superseded run logs `ledger superseded: <object> after <time>: another run changed the record
first; it is not recorded`.

```text
backup schedule started (UTC): dump daily at 16:00, ledger hourly at :05; last good backup backups/20261113T160000.123Z.dump at 2026-11-13T16:00:01.002Z, last good ledger ...
ledger ok: ledger/20261113T170500.004Z.json, 93 bytes, 0 rows, 0.1 s
backup ok: backups/20261114T160000.031Z.dump, 280697 bytes, 0.4 s
ledger FAILED: ledger/20261113T180500.002Z.json after 0.1 s: head ledger/20261113T180500.002Z.json: 403
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
  rule and lock.

So the schedule lives in a small long-running process from the cutover image. It survives a
redeploy and a restart because it keeps no state of its own: at start, and again just before a
run, it reads the last good run from the bucket. A run is due when no good run started at or after
its last slot (16:00 for the dump, :05 for the ledger), so a service that was down for three days
runs once when it comes back, not three times, and a redeploy that lands just after a run does not
repeat it. A status record that does not hold up (not JSON, the wrong shape, an object name of the
wrong kind, times that are not times, out of order or more than five minutes in the future) counts
as no record: the kind runs now (except a record dated in the future, which is never written over;
above), and the log says why, in one line per tick at most: `status records: ledger not JSON;
counted as none`. Each minute's tick reads both records again, so a run from the console counts
too. Kinds run independently, so a long dump does not hold the hourly export, and a tick never
waits for a run or a mail. A failed run is retried 15
minutes later; a run never overlaps another of its kind (the advisory lock). SIGTERM stops the
schedule and signals any run in flight to stop (the dump is killed, the export's query cancelled,
the upload aborted, the files removed). The schedule waits at most 8 seconds for them, then lets
go; the process exits a second later whatever is still open, which also ends any database session
a stuck run held (and with it the lock).

## Setting it up on Easypanel

In the project, beside `web` and `worker`:

1. Create an App service `backup`, in one call or in this order before its source exists: build
   type Dockerfile, file `tools/cutover/Dockerfile`; deploy command
   `exec node tools/cutover/src/cli.ts backup-schedule` (Easypanel runs the command through
   `sh -c`; `exec` makes Node the container's first process, so SIGTERM reaches it); one replica;
   no domain, no port. Set the environment below.
2. Upload the same source archive as `web` (staging) or point it at the same Git source. The
   upload deploys it.
3. The log shows `alert mail on, to ...` (or why it is off) and `backup schedule started ...` and,
   on a bucket with no status records yet, a ledger export and a dump straight away.

| Variable                                                 | Value                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                           | the same as `web`'s                                                                                                                |
| `BACKUP_S3_ENDPOINT`                                     | the bucket's S3 API as a bare origin, https: `https://<account id>.r2.cloudflarestorage.com` for R2. No path, query or credentials |
| `BACKUP_S3_BUCKET`                                       | the backup bucket, never the media bucket                                                                                          |
| `BACKUP_S3_REGION`                                       | `auto` for R2, `us-east-1` for MinIO                                                                                               |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | the key limited to the backup bucket                                                                                               |
| `S3_BUCKET`                                              | the media bucket's name, required: the run refuses a backup bucket equal to it                                                     |
| `S3_ACCESS_KEY_ID`                                       | optional, the media key's id: the run then also refuses the media key as the backup key                                            |
| `BACKUP_S3_ALLOW_PLAIN_HTTP`                             | **never in production.** `1` lets the endpoint be `http://`, for a store inside the project network only (staging's MinIO)         |
| `SMTP_URL`, `MAIL_FROM`                                  | as `web`'s: the alerts go through the same mail code (`packages/core/src/identity/mail.ts`)                                        |
| `BACKUP_ALERT_TO`                                        | the one address the alerts go to                                                                                                   |

Give the service at least 768 MB of memory and free disk in the container for one dump (below).
The database user needs to read every table; staging uses `web`'s. A read-only role would do for
the dump and the export; the drill needs one that may create a database.

## Alerts

One rule, worked out on every tick (each minute) for each kind, whether or not a run of it is
going, with nothing stored:

- The kind's age is counted from the finish of the last good run in its status record, whoever
  wrote it. With no readable good record it is counted from this process's start.
- The kind is overdue when that age is over 26 hours for the dump (one day and two hours of slack)
  or 2 hours for the ledger (one hour and one hour of slack). Each dump starts at 16:00, so one that
  runs more than about two hours longer than the one before goes overdue while it runs, and mails.
  Today's dump takes under a second. How long a dump may run grows with its size (the transfer
  budgets under "Size and time limits"): about 8 hours for 5 GiB, while at the largest supported
  object, 156.25 GiB, the three transfer budgets alone come to about 5.6 days. A dump that large
  would be overdue every day and its daily slot skipped while the run holds the lock.
- An overdue kind is mailed to `BACKUP_ALERT_TO` when this process has not sent an overdue mail for
  it in the last 24 hours. Only a mail that went out counts; the mark is in memory, so a restart, or
  a second container during a redeploy, may send one more.

A failed run mails nothing by itself: a failure that lasts shows as overdue, and a skipped or
superseded run is the same. The mail names the kind, the last good run's finish (or `none
recorded`) and the age, this process's last failure for the kind if it saw one (the fixed words of
its log line, such as `get status/ledger.json: 403 AccessDenied` or `timed out`), and where to look
(the service log, `backup-status`, this file); never a credential, a URL or a row.

Mail never holds a run, a tick or the shutdown: the tick starts the send and goes on, one send at a
time in the process (an overdue kind that finds one in flight is tried on a later tick), and on
SIGTERM a send in flight is not waited for. The send goes through core's mail code with finite SMTP
limits (nodemailer 10.3.1): 10 s for the DNS lookup, connecting and the greeting together, then 20 s
of silence on the socket for each later reply, and 2 minutes for the whole send
(`SMTP_SEND_LIMIT_MS`, for `web` and `worker` too). The silence limits alone would not end a
server that keeps sending empty lines without answering; the 2 minutes do: each send has a socket
of its own, which is destroyed then, and nodemailer fails the send. So a server that never answers
ends the send in about 10 s, and no send takes longer than about 2 minutes. A send that fails or times out is logged without the server's text and tried again on a
tick no sooner than 15 minutes after it ended.

A service that is not running cannot mail. The operator's check of a service that may have stopped
is `backup-status` (below), which needs no running schedule.

The recipient is a variable, not the site's `contact.email` setting, for two reasons: the alert
must work when the database does not answer, which is one of the failures it reports, and
`contact.email` is the published contact for the legal pages, which may be a shared or public
address, or empty. If `SMTP_URL`, `MAIL_FROM` or `BACKUP_ALERT_TO` is not set, the service says
`alert mail is off: ... not set` once at start and runs without alerts.

## Knowing it ran

The signal is the status records in the bucket, which only a good, checked run writes. In the
`backup` console:

```sh
node tools/cutover/src/cli.ts backup-status   # exit 0 when both are good and fresh, 1 otherwise
```

```text
backup: backups/20261113T160000.123Z.dump, 280697 bytes, finished 2026-11-13T16:00:01.002Z (5 min ago)
ledger: ledger/20261113T160500.004Z.json, 93 bytes, finished 2026-11-13T16:05:00.120Z (0 min ago)
```

It checks each record against the bucket: the object it names must exist with the recorded size,
`sha256` metadata and ETag. A missing or mismatched object, a record that does not hold up, no
record, or a run older than 26 hours (dump) or 2 hours (ledger) is reported on that kind's line
and makes it exit 1. `--json` gives the same report machine-readable. The overdue mail above is
the push form of the same signal, from a running service only.

## Retention: the bucket's lifecycle rule and lock

The tool never deletes old backups. The bucket does: every object expires 30 days after it was
written, and in production a bucket lock keeps everything under `backups/` and `ledger/` from being
deleted or overwritten for those 30 days, by anyone holding the key. Lifecycle rules run in the
background, on R2 and MinIO alike, so an object is removed some time after it expires (typically
within a day), not at the 30-day mark exactly. The status records live under
`status/`, outside the lock, because they are rewritten on every good run; they never expire while
backups run. Once the service has been failing for 30 days the bucket holds nothing under
`backups/`, which `backup-status` and the overdue mail say long before.

### R2 (production; waits on Andrew, R2 is not on)

R2 is off on the account: the Cloudflare token answers 403 for R2 (staging.md). When Andrew turns
R2 on:

1. Cloudflare dashboard, R2, Create bucket: name `peblish-backups`, location automatic (or the
   hint nearest the server), default storage class Standard. Public access stays off (no
   `r2.dev` URL, no custom domain).
2. The bucket, Settings, Object lifecycle rules, Add rule: name `expire-30-days`, applies to all
   objects, "Delete uploaded objects" after 30 days, and "Abort incomplete multipart uploads"
   after 1 day (a run killed mid-upload leaves parts that are not objects).
3. The bucket, Settings, Bucket lock rules, Add rule twice: `lock-backups` with prefix `backups/`
   and `lock-ledger` with prefix `ledger/`, each "Retention period" 30 days. Not `status/`, and
   not the whole bucket: the service rewrites its status records (and its probe,
   `status/conditional-probe.json`). The lock and the lifecycle rule agree: an object can be
   deleted once it is 30 days old, and the lifecycle rule deletes it some time after that.
4. R2, Manage R2 API Tokens, Create API token: name `peblish-backup`, permission "Object Read &
   Write", "Apply to specific buckets only" with `peblish-backups` only, TTL forever (or a date to
   rotate). R2 tokens cannot leave out delete; the bucket lock is what protects the backups from a
   stolen key. Copy the access key id and secret into the production env file, never into a chat.
5. The endpoint is `https://<account id>.r2.cloudflarestorage.com`, region `auto`. Set the
   variables on the production `backup` service (without `BACKUP_S3_ALLOW_PLAIN_HTTP`) and deploy
   it.
6. Check: in its console `node tools/cutover/src/cli.ts backup-run ledger` (exit 0, an `ok` line),
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

Staging has no bucket lock (MinIO's object lock needs a bucket created with it); its key's lack of
delete permission stands in for it. MinIO's lifecycle rules have no abort of incomplete uploads;
MinIO itself removes uploads older than `stale_uploads_expiry` (24 hours, read from
`mc admin config get local api`). Staging's endpoint is `http://peblish-staging-minio:9000`,
inside the project network, so it sets `BACKUP_S3_ALLOW_PLAIN_HTTP=1`; production never does.

## Restore from the bucket

In the `backup` console (it has the bucket key and Postgres 17 client tools):

```sh
cd /app
node tools/cutover/src/cli.ts backup-fetch --dir /tmp/cutover/fetch [--object backups/<time>.dump] [--ledger-object ledger/<time>.json]
```

It downloads the backup and the ledger export that `status/backup.json` and `status/ledger.json`
name as last good, or the ones named with `--object` and `--ledger-object` (each must still match
its own `sha256` metadata; a named one needs no valid record for its kind, so `--object` works when
`status/backup.json` is damaged), into a mode 700 folder as mode 600 files, checks each while it
downloads, and prints the two paths and how it chose each. Newer objects that no record names (an
upload that failed its check, a superseded run's) are passed over. If either destination file
exists, it refuses before fetching anything, and it refuses any folder at or inside the service's
temporary root (`/tmp/peblish-backup`), which backup runs clear, before reading anything; a download that fails, does not match or is stopped
removes only what this fetch made (the folder too, if it made it). Then either:

```sh
# The drill on the fetched files: restore into a new drill_<time>_<random>, re-apply, compare counts, drop it.
node tools/cutover/src/cli.ts drill --db "$DATABASE_URL" --dir /tmp/cutover/drill --backup <backup file> --ledger <ledger file>
# A real restore into a NEW database, then point the services at it (deploy/cutover.md).
node tools/cutover/src/cli.ts restore --backup <backup file> --db <new database url> --ledger <ledger file>
rm -rf /tmp/cutover/fetch /tmp/cutover/drill
```

The drill's counts differ where the database changed since that backup; on a quiet database they
match. If the damaged database still answers, run `backup-run ledger` first so the last good
ledger export is current.

## Size and time limits

The upload holds one 16 MiB part in memory at a time. S3, R2 and MinIO allow 10,000 parts, so the
largest object is 156.25 GiB; every part but the last is the same size, as R2 requires. Multipart
rather than one PUT because a single PUT tops out at 5 GiB on S3 and R2 and could not be checked
part by part.

Each request (a part, a HEAD, a status record) has 2 minutes; aborting an unfinished upload has 5
seconds. Hashing the file, uploading it and reading it back each have a budget of their own: 10
minutes plus one second per MiB (a 5 GiB dump: about 95 minutes each, so 1 MiB/s is the slowest
sustained rate allowed, and the three together may take up to about 4 h 45 min at that rate). A
streamed read (the check after an upload, a fetch for a restore) is also abandoned when nothing
arrives for 60 seconds.

The ledger export is written as it is read (a cursor of 500 rows), so its size does not touch
memory. A ledger row is a few hundred bytes and the ledger grows with every remote deletion
federation records, so it can reach millions of rows over years. A restore still reads the export
whole (`readLedgerExport`); at a million rows that is a few hundred MB, in a console run, not the
service.

Tested (2026-11-13, a MacBook, the dev MinIO):

- In the test suite: an 11 MiB file with 5 MiB parts (3 parts), checked by size, multipart ETag and
  read-back, and fetched back with a matching SHA-256; on a fake store, a failing part, same-size
  corruption, an unfamiliar ETag form, a stalled and a slow download, a completion another writer
  beat, and slow uploads with a separate read-back budget. A ledger export of 1,201 rows (two full
  500-row cursor batches plus 201).
- By hand, round 1: random files with the default 16 MiB parts, 256 MiB (16 parts) and 2 GiB (128
  parts). 2 GiB uploaded in 14 to 15 s and fetched back in 10 s, SHA-256 matching. Peak memory was
  480 to 520 MB for both sizes (130 MB at start): it does not grow with the file. The read-back
  check added in round 2 streams, so it adds time (about the fetch time) but no memory.
- On staging: the real dump, 280,697 bytes, one part.

Disk: a run needs room for one dump (or export) in `TMPDIR` until it is uploaded; a fetch for a
restore needs room for the backup and the export.

## Encryption

A dump holds password hashes, email addresses, two-factor secrets (encrypted with
`BETTER_AUTH_SECRET`) and the actors' private keys. As designed, what protects it in R2:

- The bucket is private (no public access, no `r2.dev` URL) and only the backup key and the
  account can read it.
- The key is limited to that one bucket, held only by the `backup` service and the env file.
- R2 encrypts every object at rest (AES-256), and the service refuses anything but https to it.

What that does not cover: anyone with the backup key, the Cloudflare account, or a fetched copy
reads everything.

**Before outside users' data is in production:** add client-side encryption. Encrypt each dump
with `age` to a public key (`pg_dump | age -r <public key>`, `age` is in Debian bookworm) before
the upload, keep the private key offline (Andrew: password manager and paper), and run one restore
drill with it. The cost is key custody: losing that private key loses every backup, and a restore
needs it on the server for the length of the restore. It is not part of the first pull request.
