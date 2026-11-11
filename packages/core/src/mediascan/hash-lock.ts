import { sql } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';

/**
 * Serialises what decides an image by its exact hash: a list change (addBlockedHash,
 * removeBlockedHash, a confirmed or expired block) and the last step of a scan (recordScan). The
 * lock is held to the end of the caller's transaction, so a scan that records after a list
 * insertion sees the entry, and a list insertion after a scan sees the clean copy and quarantines
 * it. A list change takes it before it writes its deletion_ledger row, so the ledger ids of two
 * changes to one hash follow the order the list saw them, and a restore's replay ends where the
 * list did.
 *
 * Lock order: a list insertion holds this lock while it locks clean copies, so a caller that
 * locked a media row first takes this lock only once it has seen that row is not clean. A removal
 * holds its list entry's row (the policy's recheck) before this lock; nothing that holds this lock
 * waits on an entry's row lock (an insertion's ON CONFLICT DO NOTHING does not), so that order is
 * safe.
 */
export async function lockHash(db: WriteTx, sha256: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`peblish.media_sha256:${sha256}`}, 0))`);
}
