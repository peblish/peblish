import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';
import { edgePurges } from './tables.ts';
import { ALL_TAG, type Purge } from './tags.ts';
import { MAX_OWED } from './timing.ts';

// Owing purges: written in the caller's transaction (the outbox consumer's batch, which also
// moves its cursor, the transaction that makes a host denied, or a restore), so a takedown and
// the debt it leaves commit together and any worker may pay it (send.ts).
//
// Bounds, by construction: unclaimed first sends are at most MAX_OWED (past it they collapse
// into one wide purge), and so are unclaimed second sends (send.ts collapses echoes the same
// way, and echoes never count toward a collapse of first sends); a claimed batch is at most
// MAX_OWED + 1 rows or every due row when it is wide, and only one batch is in flight. So the
// table holds at most about 3 x (MAX_OWED + 1) rows, plus the rows of transactions that commit
// at the same moment before one of them collapses (no lock is taken for that).

const unclaimed = (send: 1 | 2) => and(isNull(edgePurges.claimToken), eq(edgePurges.send, send));

const upsertWide = (db: WriteTx, send: 1 | 2, dueAt: SQL) =>
  db
    .insert(edgePurges)
    .values({ tag: ALL_TAG, send, dueAt })
    .onConflictDoUpdate({
      target: [edgePurges.tag, edgePurges.send],
      targetWhere: sql`${edgePurges.claimToken} is null`,
      set: { dueAt: send === 1 ? sql`least(${edgePurges.dueAt}, excluded.due_at)` : sql`greatest(${edgePurges.dueAt}, excluded.due_at)` },
    });

/**
 * Owes `purge` (send 1, due now). A tag already owed and not yet claimed is one row; a tag
 * claimed by a sender in flight gets a row of its own, so it stays owed whatever that send's
 * result. Past MAX_OWED unclaimed first sends, they all become one wide purge.
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
    .where(unclaimed(1));
  if ((count?.n ?? 0) <= MAX_OWED) return;
  await db.delete(edgePurges).where(and(unclaimed(1), ne(edgePurges.tag, ALL_TAG)));
  await upsertWide(db, 1, sql`now()`);
}

/** The same bound for second sends (send.ts, after a settle): one wide echo, due when the latest of them was. */
export async function collapseEchoes(db: WriteTx): Promise<void> {
  const [count] = await db
    .select({ n: sql<number>`count(*)::int`, latest: sql<string>`max(${edgePurges.dueAt})::text` })
    .from(edgePurges)
    .where(unclaimed(2));
  if (!count || count.n <= MAX_OWED) return;
  await db.delete(edgePurges).where(unclaimed(2));
  await upsertWide(db, 2, sql`${count.latest}::timestamptz`);
}

/**
 * After a backup is restored, takedowns made since the backup are applied again without their
 * events (tools/cutover drill.ts), and the edge may hold any image they hid: owe a wide purge
 * due at the start of time, so it is late at once and web answers private until it is sent
 * (ready.ts).
 */
export async function owePurgeAfterRestore(db: WriteTx): Promise<void> {
  await upsertWide(db, 1, sql`'epoch'::timestamptz`);
}

/** The rows owed and unclaimed, oldest due first (tests and operators). */
export const owedRows = (db: Pick<WriteTx, 'select'>) =>
  db
    .select({ tag: edgePurges.tag, send: edgePurges.send, dueAt: edgePurges.dueAt })
    .from(edgePurges)
    .where(isNull(edgePurges.claimToken))
    .orderBy(edgePurges.dueAt, edgePurges.tag);
