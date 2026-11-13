import { and, isNull, ne, or, sql } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';
import { edgePurges } from './tables.ts';
import { ALL_TAG, type Purge } from './tags.ts';
import { MAX_OWED } from './timing.ts';

// Owing purges: written in the caller's transaction (the outbox consumer's batch, which also
// moves its cursor, or the transaction that makes a host denied), so a takedown and the debt it
// leaves commit together and any worker may pay it (send.ts).

const owed = isNull(edgePurges.claimToken);

/**
 * Owes `purge` (send 1, due now). A tag already owed and not yet claimed is one row; a tag
 * claimed by a sender in flight gets a row of its own, so it stays owed whatever that send's
 * result. Past MAX_OWED unclaimed rows, everything unclaimed becomes one wide purge, so the debt
 * is bounded by construction: at most MAX_OWED rows plus the rows senders hold.
 */
export async function owePurges(db: WriteTx, purge: Purge): Promise<void> {
  const tags = purge === 'all' ? [ALL_TAG] : [...new Set(purge)];
  if (tags.length === 0) return;
  await db
    .insert(edgePurges)
    .values(tags.map((tag) => ({ tag })))
    .onConflictDoUpdate({
      target: [edgePurges.tag, edgePurges.send],
      targetWhere: sql`${edgePurges.claimToken} is null`,
      set: { dueAt: sql`least(${edgePurges.dueAt}, excluded.due_at)` },
    });
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(edgePurges)
    .where(owed);
  if ((count?.n ?? 0) <= MAX_OWED) return;
  await db.delete(edgePurges).where(and(owed, or(ne(edgePurges.tag, ALL_TAG), ne(edgePurges.send, 1))));
  await db
    .insert(edgePurges)
    .values({ tag: ALL_TAG })
    .onConflictDoUpdate({
      target: [edgePurges.tag, edgePurges.send],
      targetWhere: sql`${edgePurges.claimToken} is null`,
      set: { dueAt: sql`least(${edgePurges.dueAt}, excluded.due_at)` },
    });
}

/** The rows owed and unclaimed, oldest due first (tests and operators). */
export const owedRows = (db: Pick<WriteTx, 'select'>) =>
  db
    .select({ tag: edgePurges.tag, send: edgePurges.send, dueAt: edgePurges.dueAt })
    .from(edgePurges)
    .where(owed)
    .orderBy(edgePurges.dueAt, edgePurges.tag);
