import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';
import { communityPins } from '../pins/tables.ts';
import { savedPosts } from '../saves/tables.ts';
import { threadVisits } from '../visits/tables.ts';
import { threadWatches } from '../watches/tables.ts';

/**
 * The personal features' owner-only tables, each keyed by `owner_id`: saved posts, sidebar pins,
 * thread follows and visit markers. Account deletion keeps the actor row, so no foreign key
 * cascade clears them: deleteAccount does (deletePersonalData), and the restore replay
 * (tools/cutover's drill.ts) does it again from this same list after a backup brings them back.
 * A new owner-only table joins this list.
 */
export const personalTables = [savedPosts, communityPins, threadWatches, threadVisits] as const;

/** Deletes everything the personal features hold for `ownerId`, in the caller's transaction. */
export async function deletePersonalData(db: WriteTx, ownerId: Uuid): Promise<void> {
  for (const table of personalTables) await db.delete(table).where(eq(table.ownerId, ownerId));
}
