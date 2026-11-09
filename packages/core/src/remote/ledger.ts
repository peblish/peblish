import type { Uuid } from '@peblish/schema/ids';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { deletionLedger } from '../db/tables/site.ts';
import type { WriteTx } from '../db/write.ts';

// Owned by lane REM. The deletion ledger rows for what remote servers delete. The ledger is
// append-only and a backup restore re-applies it in id order (B06 drill), so a deletion that
// must survive a restore is written here in the transaction that makes it.

/**
 * Where a remote deletion came from: the author's or account's own signed Delete activity
 * (`Delete`), or its server saying so when asked (`Tombstone` for a 200 Tombstone document,
 * `Gone` for a 410). Only a signed Delete is the account's own word, which is why a valid
 * document served later cannot undo it (remote-fetch/actor.ts).
 */
export type DeletionCause = 'Delete' | 'Tombstone' | 'Gone';

export type DeletionRecord = {
  kind: 'post' | 'comment' | 'actor';
  /** The row's id (posts.id, comments.id or actors.id). */
  id: Uuid;
  cause: DeletionCause;
  /** Who asked for it: the author whose Delete arrived, or the instance when it found out by fetching. */
  actorId: Uuid;
  /** An actor's deletion that also removes the actor's posts and comments (Lemmy's `removeData`). Restore deletes them too. */
  removeContent?: boolean;
};

const actorReasons = { deleted: 'remote.actor_deleted', undeleted: 'remote.actor_undeleted' } as const;

/** The ledger's reason for a deletion of `kind`: an author's own Delete, or an object its server no longer serves. */
const reasonOf = ({ kind, cause }: Pick<DeletionRecord, 'kind' | 'cause'>) =>
  kind === 'actor' ? actorReasons.deleted : cause === 'Delete' ? 'remote.author_deleted' : 'remote.object_gone';

async function apIdOf(db: WriteTx, kind: DeletionRecord['kind'], id: Uuid): Promise<string | null> {
  switch (kind) {
    case 'actor':
      return (await db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, id)))[0]?.apId ?? null;
    case 'post':
      return (await db.select({ apId: posts.apId }).from(posts).where(eq(posts.id, id)))[0]?.apId ?? null;
    case 'comment':
      return (await db.select({ apId: comments.apId }).from(comments).where(eq(comments.id, id)))[0]?.apId ?? null;
  }
}

/**
 * Writes one `deletion_ledger` row for a remote deletion, in the caller's open transaction (so
 * the row commits with the state change it records). The subject's ap_id is read from its row.
 * The inbound handlers call it for an author's own Delete of a post or comment; this lane's
 * mutations call it for the rest. `details` is `{ remote: true, cause, removeContent? }`.
 */
export async function recordDeletion(t: { db: WriteTx }, input: DeletionRecord): Promise<void> {
  await t.db.insert(deletionLedger).values({
    subjectKind: input.kind,
    subjectId: input.id,
    subjectApId: await apIdOf(t.db, input.kind, input.id),
    reason: reasonOf(input),
    requestedBy: input.actorId,
    details: { remote: true, cause: input.cause, ...(input.removeContent === undefined ? {} : { removeContent: input.removeContent }) },
  });
}

/** Records that a deleted remote actor was brought back (an explicit Undo, or a valid document after a Tombstone). */
export async function recordUndeletion(t: { db: WriteTx }, actorId: Uuid, by: Uuid): Promise<void> {
  await t.db.insert(deletionLedger).values({
    subjectKind: 'actor',
    subjectId: actorId,
    subjectApId: await apIdOf(t.db, 'actor', actorId),
    reason: actorReasons.undeleted,
    requestedBy: by,
    details: { remote: true },
  });
}

/** What the ledger says about a deleted remote actor since it was last undeleted. */
export type ActorDeletionState = {
  /** Its own signed Delete was received at least once. */
  signedDelete: boolean;
  /** Some deletion asked for its content to go too. */
  removeContent: boolean;
};

/**
 * The strongest of the actor's deletions since the last undelete, or null when the ledger holds
 * none (the actor is alive, or was deleted before the ledger existed). Read it inside the
 * transaction that holds the actor's row, so a concurrent deletion is either counted or waits.
 */
export async function actorDeletionState(q: Queryable, actorId: Uuid): Promise<ActorDeletionState | null> {
  const rows = await q
    .select({ reason: deletionLedger.reason, details: deletionLedger.details })
    .from(deletionLedger)
    .where(
      and(
        eq(deletionLedger.subjectKind, 'actor'),
        eq(deletionLedger.subjectId, actorId),
        inArray(deletionLedger.reason, [actorReasons.deleted, actorReasons.undeleted]),
      ),
    )
    .orderBy(desc(deletionLedger.id));
  let state: ActorDeletionState | null = null;
  for (const { reason, details } of rows) {
    if (reason === actorReasons.undeleted) break;
    const one = typeof details === 'object' && details !== null ? details : {};
    state ??= { signedDelete: false, removeContent: false };
    state.signedDelete ||= 'cause' in one && one.cause === 'Delete';
    state.removeContent ||= 'removeContent' in one && one.removeContent === true;
  }
  return state;
}
