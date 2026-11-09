# Lane FX-MEDIA notes (wave 3 review fixes: media scanning, evidence, the admin Media tab)

Branch `mvp-w3-fx-media` from `w3-review` (96d94dd), worktree `/Users/admin/Projects/feddit-mvp-w3-fx-media`, `lane.sh` name `safe` (database `peblish_safe`, recreated once at the start because it held migrations from older files), port 18318. Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`.

## 1. What landed

| Finding                                              | Commit  | Proving test (fails before the fix, passes after)                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D5 (S12) bucket read failures escape the retry limit | 239c968 | `c/mediascan/job.test.ts` "a bucket read failure is retried like an outage, and the fifth attempt settles the row as failed"                                                                                                                                                                                                                                                                                    |
| D6 stale scan claims settle others' work             | 2473843 | `c/mediascan/job.test.ts` "a claim whose lease ran out settles nothing once another worker has claimed the row again"                                                                                                                                                                                                                                                                                           |
| D2 (S2, A6) in-flight scan versus a new list entry   | 4f967e9 | `c/mediascan/scan.test.ts`: "a list entry added while a scan is in flight wins over the scan finding nothing" (gated provider), "a scan's last step waits for a list insertion in progress and then records the match" and "a list insertion waits for a scan's last step in progress and then quarantines the copy it made clean" (second connection holding the hash lock, waiter seen in `pg_stat_activity`) |
| S6 confirming a block leaves clean copies served     | bae62ae | `c/mediascan/review.test.ts` "confirming a block quarantines the clean copies of the same image, as adding its hash does"                                                                                                                                                                                                                                                                                       |
| S7 a requarantine overwrites the earlier incident    | 9177d32 | `c/mediascan/review.test.ts` "a requarantine opens a new incident: the earlier one keeps its record, and the new one starts its own clock"                                                                                                                                                                                                                                                                      |
| D1 (S3, A5) hold versus purge race                   | a203edf | `c/mediascan/review.test.ts` "a hold cannot land between the purge claiming the bytes and its bucket delete" (bucket delete held on a gate while the hold is tried)                                                                                                                                                                                                                                             |
| D4 (S5) evidence purge starvation                    | 82d5b6f | `c/mediascan/review.test.ts` "held images and failing deletions cannot fill the purge batch"                                                                                                                                                                                                                                                                                                                    |
| S8 only an AFP direction keeps image bytes           | 7c49303 | `c/mediascan/review.test.ts` "only an AFP direction keeps the image bytes: NCMEC and NCA holds keep the record, and the bytes follow the normal purge"                                                                                                                                                                                                                                                          |
| W10 (Media) denial answers 200                       | eed01a8 | `e2e/mediascan/media.spec.ts` "a signed-in member who is not an admin gets a 403 with the denial and no data" (run against a build without the fix: received 200)                                                                                                                                                                                                                                               |

How each is fixed:

- D5: `decide()` (`c/mediascan/scan.ts`) catches a failed `store.get` and returns a retryable `failed` outcome (`the stored object could not be read`; the raw error is not kept, it can name the endpoint).
- D6: `claimScan` writes a fresh `claim_token` per claim and returns it in `Claimed.token`; `recordScan` takes `token` and refuses `media.not_pending` unless it is the row's current token; settling clears it.
- D2: `c/mediascan/hash-lock.ts` `lockHash(db, sha256)` is a transaction-scoped advisory lock per hash. `addBlockedHash` takes it before its duplicate check and insert; `recordScan` takes it (after its state and token checks) and rechecks the list: a clean or failed result for a hash listed meanwhile is recorded as the list match (pending to quarantined, list verdict, evidence and manifest), exactly as a scan that met the list at its start. `recordScan` now returns the state it recorded and `scanClaimed` reports it.
- S6: `blockMedia` (`c/mediascan/block.ts`, used by an admin's confirmation and the undecided expiry) inserts the hash under the hash lock, then quarantines every clean, undeleted copy with that SHA-256 under the entry. `releaseMatch` takes the hash lock too, so a release cannot slip past a concurrent sweep.
- S7: `media_evidence.media_id` is no longer unique; each quarantine inserts a new row with `created_at` = the quarantine's `now` (the auto-block clock). Decisions, holds and the purge claim act on the latest row; `expireUndecided` reads the open row; `expireManifest` takes an `evidenceId` and expires one incident at a time. The log still says `requarantined` on the new row.
- D1: `purgeBytes` now runs `beginPurge` (media row and evidence rows locked `FOR NO KEY UPDATE`; refuses when a hold keeps the bytes; marks the current incident `purge_started_at` with a `purge_started` log line), then the bucket delete, then `finishPurge` (clears the key). `recordHold` refuses `media.already_decided` once `purge_started_at` is set.
- D4: the purge pass's byte step excludes held images in SQL (`heldSql`, the twin of `holdKeepsBytes`) and rows still backing off, orders by `created_at`, then applies the limit. A failed bucket delete runs `deferPurge`: `media_scans.purge_attempts + 1`, `purge_retry_at` = now plus 1, 2, 4 ... minutes, at most a day. `purgePass` takes an optional `batch` (default 200) for tests.
- S8: `media_evidence.hold_authority` (`afp`, `ncmec`, `nca`). `recordHold` requires it (an unknown value is `media.hold_invalid`) and logs it (`AFP <reference> until <date>`). Only an AFP hold in force keeps the bytes and stops the undecided expiry; NCMEC and NCA holds keep the manifest, hashes and log (retention still runs to at least the hold date) and the bytes follow the normal purge. Web: one native `<select name="authority">` on the existing hold form (required, no preselected value), the help line rewritten, the hold shown with its authority in the review detail and the evidence table.
- W10: `loadMedia` calls `setResponseStatus(403)` before returning `not-admin` or `needs-two-factor`, as `w/routes/admin/reports/-load.ts` does. The page and its denial copy are unchanged.

## 2. Commits

239c968 D5, 2473843 D6, 4f967e9 D2, bae62ae S6, 9177d32 S7, a203edf D1, 82d5b6f D4, 7c49303 S8, eed01a8 W10, then this file.

## 3. Verification

- `pnpm check` before each commit. Final runs: 2,517 passed, 7 skipped (218 files passed, 4 skipped). Three runs had one unrelated failure each, a timeout under the shared Postgres load, each passing alone right after: `c/authz/moderators-cache.test.ts` (D5 and D4 runs, 4 of 4 alone) and `packages/federation/src/inbound/pipeline.test.ts` (S8 run, 32 of 32 alone). The D6 run first stopped at prettier on a test file; formatted, lint passed, `pnpm test` passed (2,510).
- `pnpm build && pnpm e2e` at the end: 354 passed, 1 skipped (`MEDIASCAN_LOCAL_ONLY=1` is already in `e2e/playwright.config.ts`).
- Each race test was also run with its fix removed (temporary edits, restored) to confirm it fails: D6, all three D2 tests, D4, S8; D1, S6, S7 and D5 were run before the fix existed.
- Tests and the lane's e2e database ran on a scratch migration: copy of `packages/core/drizzle/` plus a generated `0010_fx_media.sql` in the scratch folder (`PEBLISH_MIGRATIONS_DIR`). Nothing under `packages/core/drizzle/` changed.

## 4. Decisions and deviations

1. D2: root's response says the recording step "records `blocked` (quarantine path)". I record `quarantined` with a list verdict, through `quarantine()`: that is the path a list match takes at the start of a scan, and `pending` cannot move to `blocked` in the state machine. The admin then confirms, or the undecided expiry blocks it.
2. D2 lock order: the mutations' recheck locks the media row before the body runs, so the order is media row, then hash lock. A list insertion holds the hash lock while it locks clean copies, so every caller takes the hash lock only after it has seen its own row is not clean (recordScan: pending; confirm, release, expiry: quarantined). Documented in `hash-lock.ts`.
3. D2 and S6: `releaseMatch` also takes the hash lock (not named by root) so a release cannot commit between a confirmation's copy sweep reading and finishing; without it the released copy ended clean although listed.
4. D6: a stale token is refused as `media.not_pending` (the closed list has no better reason and refusals are root's files); `scanClaimed` already reports any refusal as `settled-elsewhere`.
5. S6: a copy is quarantined whenever it is clean, including one an admin released earlier. A confirmation of the same bytes is newer evidence; the copy goes back to review rather than staying served.
6. S7: earlier incidents are untouched by later events: the purge claim marks only the current incident, and a hold is recorded on the current one. A hold in force on any incident still keeps the bytes; each manifest expires by its own retention and hold.
7. D1: the claim also logs `purge_started` in the evidence log (existing tests updated). Once deletion has begun it is finished by retries; a hold is refused from then on even if the delete fails.
8. D4: the back-off lives on `media_scans` (`purge_attempts`, `purge_retry_at`), since failed rows have no evidence row. Rows are upserted there on the first failed delete.
9. S8: the select starts on a disabled "Choose" option, so an admin must pick; defaulting to AFP would keep imagery without an AFP direction. A missing value from a form is `form.invalid`.
10. S8 copy, deviating slightly from "one line": besides the named help line (`media.hold.help`), I changed four strings that the AFP rule made wrong or that show the authority, in `en` and `de`: `media.d.holdValue` (now `{authority} {reference} until {date}`), `media.d.autoBlockAt` ("unless an AFP hold is recorded"), `media.confirm.help` ("unless an AFP hold is recorded"), `media.hold.referencePlaceholder` ("Direction or report number"); and added `media.hold.authority`, `media.hold.authorityChoose`, `media.hold.authority.{afp,ncmec,nca}`. The review detail now shows the hold line and, unless an AFP hold stands, the auto-block line (before, one or the other). German copy is mine and unreviewed.
11. W10 deviation (write set): the proving test is a new case in `e2e/mediascan/media.spec.ts`, outside the listed write set. It seeds a member in-process with `seedAccount`, as `e2e/payload/seed.ts` and `e2e/composer/seed.ts` do. No other lane owns that spec.
12. `purgeBytes` now returns false (not throws) when `media.scan` is not authorised for the id (an unknown row); every caller already treated a throw as false.

## 5. Requests to root

1. Schema for `0010_wave_3_fixes.sql`, from `c/mediascan/tables.ts` and `c/evidence/tables.ts` (my scratch SQL, drizzle-kit 0.31.11):

   ```sql
   ALTER TABLE "media_evidence" DROP CONSTRAINT "media_evidence_media_id_unique";
   ALTER TABLE "media_evidence" ADD COLUMN "hold_authority" text;
   ALTER TABLE "media_evidence" ADD COLUMN "purge_started_at" timestamp with time zone;
   ALTER TABLE "media_scans" ADD COLUMN "claim_token" uuid;
   ALTER TABLE "media_scans" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;
   ALTER TABLE "media_scans" ADD COLUMN "purge_retry_at" timestamp with time zone;
   CREATE INDEX "media_evidence_media" ON "media_evidence" USING btree ("media_id","created_at");
   ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_hold_authority" CHECK ("media_evidence"."hold_authority" in ('afp', 'ncmec', 'nca'));
   ```

2. Nothing deployed holds evidence rows, so no data migration is needed for `hold_authority` (null on old rows means "keeps no bytes").
3. If root prefers, `e2e/mediascan/media.spec.ts`'s new 403 case can move wherever FX-WEB puts its W10 cases; it needs nothing from them.

## 6. Requests to other lanes, through root

None.

## 7. Dependencies added

None.

## 8. For later lanes

- `recordScan(grant, { outcome, now, token })` needs the claim's `token`; claim with `claimScan` first (tests: see `record()` in `c/mediascan/scan.test.ts`).
- Anything that inserts a hash into `media_blocklist` or settles a scan must take `lockHash` (`c/mediascan/hash-lock.ts`) and follow its lock-order note.
- An image's current incident is its latest `media_evidence` row (`created_at desc, id desc`); there can be several per image.
- `holdKeepsBytes` and `heldSql` (`c/mediascan/purge.ts`) are the one definition of "a hold keeps the bytes".
- `holdQuarantined(principal, { mediaId, authority, reference, until })`.

## 9. Left open and risks

- A new hold replaces the current incident's hold, as before: an admin could replace an AFP hold with an NCMEC one and so release the bytes to the purge. Every hold stays in the evidence log. I left it as it was rather than invent a refusal (none fits the closed list); worth a rule if Andrew wants holds to only widen.
- The hold form with its new select was checked by typecheck, the i18n parity test and the e2e and axe run of the review page, not by eye in a browser.
- `deferPurge` backs off failed deletes of any blocked or failed row; a bucket outage now slows the purge to the back-off schedule (at most a day between tries per row), which is the intent.
