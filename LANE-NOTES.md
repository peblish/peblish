# Lane FR-B notes (wave 3 fix round 2: the 0010 hold guard, incident byte status, block deadlock)

Branch `mvp-w3-fr-b` from tag `w3-fixes` (2566ed1), worktree `/Users/admin/Projects/feddit-mvp-w3-fr-b`, `lane.sh` name `safe` (database `peblish_safe`, port 18318). Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`.

## 1. What landed

| Item | Commit  | Proving test (fails before the fix, passes after)                                                                                                                                                                                                                                  |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4   | 435a699 | `c/db/migrate.test.ts` "0010 refuses to run while a preservation hold is in force, since it would leave the hold without an authority"                                                                                                                                             |
| R5   | 50b8877 | `c/mediascan/overview.test.ts` "every incident of an image shows what is stored now: a released one says kept only while the image is clean"                                                                                                                                       |
| R6   | d45ad86 | `c/blocks/mutations.test.ts` "A blocks B while B blocks A: both apply" and "blocking a community while one of its moderators bans the blocker there: both apply" (both 40P01 before the fix); "two blocks at once by one person take turns, so the cap stays exact" guards the cap |

How each is fixed:

- R4: `packages/core/drizzle/0010_wave_3_fixes.sql` starts with a hand-written `DO` block, before the generated statements. It counts `media_evidence` rows with `hold_reference` set and `hold_until > now()` and, if any, raises: "N media_evidence row(s) has/have a preservation hold in force. 0010_wave_3_fixes adds hold_authority, and only an AFP hold keeps the image bytes after it. Add a data fix to this migration to classify each active hold's authority (afp, ncmec or nca) before applying it, or the next purge may delete bytes the hold protects." Drizzle runs all pending migrations in one transaction, so nothing of 0010 is applied. The test migrates a database to 0009 from a temporary folder (the journal cut before 0010, the SQL files copied), inserts an active hold, expects the exception and no `hold_authority` column, then moves the hold date into the past and expects 0010 to apply. Journal and snapshot untouched; `0010` was not regenerated.
- R5: `mediaOverview` (`c/mediascan/overview.ts`) derives an evidence row's `bytes` from the image now, not from the incident's status: `purged` when the media row has no storage key, `kept` while the image is clean, `held` while an AFP hold is in force on any of its incidents (`heldSql`, the existing twin of `holdKeepsBytes`), `waiting` otherwise. The test walks one image through release (kept), requarantine (the released incident shows waiting), an AFP hold and confirmation (both incidents held), and the purge after the hold date (both purged).
- R6: `addBlock` (`c/blocks/mutations.ts`) takes `pg_advisory_xact_lock(hashtextextended('peblish.block_add:<blockerId>', 0))` before the inner rechecked mutation, instead of `FOR NO KEY UPDATE` on the blocker's actor row. The principal refresh's `FOR SHARE` on that row is unchanged, so a site ban still waits for the block or is seen by its recheck (the existing site-ban test still passes). The interleaving is forced by a third connection holding the acting people's `auth_user` rows `FOR NO KEY UPDATE`: each block has taken its first lock and waits in the principal refresh, the test polls `pg_stat_activity` for both waiters, then releases.

## 2. Commits

435a699 R4, 50b8877 R5, d45ad86 R6, then this file.

## 3. Verification

- `pnpm check` before each commit, all green on their first full run: R4 2,587 passed, 7 skipped; R5 2,588 passed, 7 skipped; R6 2,590 passed, 7 skipped. The first R4 run stopped at prettier on `migrate.test.ts`; formatted and reran in full. No load timeout, so no rerun alone was needed.
- Each proving test was run before its fix and failed: R4 (0010 applied), R5 (`kept` where `waiting` was expected), R6 (both deadlock tests 40P01). The R6 cap test was run with the advisory lock removed (temporary edit, restored): both blocks were created, past the cap.
- `pnpm build && pnpm e2e` at the end: 356 passed (323 parallel, 33 serial), 1 skipped.
- `LANE-NOTES.md` itself: `pnpm lint` (formatting included) before its commit, no full `pnpm check` since it changes no code.
- `peblish_safe` was dropped and recreated twice: at the start (it held FX-MEDIA's scratch `0010_fx_media`) and before e2e (it held the unguarded `0010`, see section 5).

## 4. Decisions and deviations

1. R4 message: root asked for a message naming the fix. The column does not exist before 0010, so an operator cannot classify holds and then run 0010 unchanged; the message says to add a data fix to this migration that classifies each active hold. A hold with a reference but no date, or a past date, is not active and does not stop the migration, as root defined.
2. R5 goes slightly beyond root's wording (check storage before "Kept"), following the reviewer's "derive byte status from the current media state and effective holds": a released incident of an image that is quarantined again shows `waiting`, not `kept`, and any incident of an image under an AFP hold shows `held`. `kept` now means the stored image is clean and served. No copy changed; the type's comment says what each value means.
3. R6, profile edits: `updateProfile` locks only the editor's own actor row, which its body updates, and reads no other actor's row, so the cycle cannot form there. Left as it is, as root allowed.
4. R6 test: the old "two blocks at once both apply, without a deadlock" test held alice's row `FOR SHARE`, which no longer makes a block wait. I replaced it with the cap test, which forces two blocks by one person to start together and needs one `block.limit`; it covers both blocks running without a deadlock too.
5. R6: the advisory lock is the outer mutation's first lock, so lock order is blocker's advisory lock, then the recheck's rows. A hash collision between two blockers only makes them take turns.

## 5. Requests to root

1. The guard changes `0010`'s hash. Every database migrated with the earlier `0010` (root's `peblish_root`, the other lanes', CI caches if any) now gets `MigrationHistoryError` and needs recreating with the command `lane.sh` prints. FR-A and FX-INTEROP will meet this when they merge this branch or `w3-final`.
2. `README.md` line 52, outside my write set: "A mutation that must lock the acting actor's row before the recheck reads it (`updateProfile`, `addBlock`) sets `recheck: 'inner'`" now describes `addBlock` wrongly. Suggested: "A mutation that must take a lock before the recheck reads its rows (`updateProfile` locks the acting actor's row; `addBlock` takes a per-blocker advisory lock) sets `recheck: 'inner'`".
3. `0011` at integration: FR-B changed no schema. When root generates `0011` from FR-A's schema, the guard stays at the top of `0010`; drift is unaffected (the drift check compares the snapshot, which the guard does not touch).

## 6. Requests to other lanes, through root

None.

## 7. Dependencies added

None.

## 8. For later lanes

- A write that needs to serialise one person's actions should prefer a transaction advisory lock keyed by the person over a stronger lock on their actor row, unless the body updates that row: the principal refresh reads it `FOR SHARE`, and other people's writes read it `FOR SHARE` after locking their own rows.
- A hand edit to a generated migration changes its hash; databases migrated from the old file must be recreated.

## 9. Left open and risks

- The guard in `0010` is hand-written SQL in a generated file. Regenerating `0010` would drop it; root's integration should keep `0010` as committed here.
- R5: the overview runs `heldSql` as a correlated subquery per evidence row (at most 50 rows), on the `media_evidence_media` index. Not measured.
