import { comments, posts } from '@peblish/core/db/tables/content';
import { deletionLedger } from '@peblish/core/db/tables/site';
import type { OpenTx } from '@peblish/core/tx/tx';
import { eq } from 'drizzle-orm';

// The deletion ledger entries for an author's own Delete of a post or comment and for the
// Undo that takes it back, written in the transaction that applies the activity.
//
// integration: replace `recordDeletion` with the one lane rem exports from core/remote (same
// signature: recordDeletion(tx, { kind, id, cause, actorId, removeContent? })) and delete this
// file's copy. `recordRestoration` has no counterpart in the contract; keep it, or fold it into
// rem's helper.

type Content = { kind: 'post' | 'comment'; id: string; actorId: string };

async function apIdOf({ db }: OpenTx, { kind, id }: Content): Promise<string | null> {
  const table = kind === 'post' ? posts : comments;
  const [row] = await db.select({ apId: table.apId }).from(table).where(eq(table.id, id));
  return row?.apId ?? null;
}

/** One `deletion_ledger` row for a remote author's Delete, so a backup restore re-applies it. */
export async function recordDeletion(t: OpenTx, input: Content & { cause: 'Delete' | 'Tombstone' | 'Gone' }): Promise<void> {
  await t.db.insert(deletionLedger).values({
    subjectKind: input.kind,
    subjectId: input.id,
    subjectApId: await apIdOf(t, input),
    reason: 'remote.object_deleted',
    requestedBy: input.actorId,
    details: { remote: true, cause: input.cause },
  });
}

/** The row after a deletion's: the author took the Delete back, so a restore that applies the ledger in order ends with the object alive. */
export async function recordRestoration(t: OpenTx, input: Content): Promise<void> {
  await t.db.insert(deletionLedger).values({
    subjectKind: input.kind,
    subjectId: input.id,
    subjectApId: await apIdOf(t, input),
    reason: 'remote.object_undeleted',
    requestedBy: input.actorId,
    details: { remote: true },
  });
}
