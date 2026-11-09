import { sql } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';

/**
 * Serialises what decides an image by its exact hash: a list insertion (addBlockedHash, a
 * confirmed block) and the last step of a scan (recordScan). The lock is held to the end of the
 * caller's transaction, so a scan that records after a list insertion sees the entry, and a list
 * insertion after a scan sees the clean copy and quarantines it.
 *
 * Lock order: a list insertion holds this lock while it locks clean copies, so a caller that
 * locked a media row first takes this lock only once it has seen that row is not clean.
 */
export async function lockHash(db: WriteTx, sha256: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`peblish.media_sha256:${sha256}`}, 0))`);
}
