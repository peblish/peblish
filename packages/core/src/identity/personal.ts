import type { Uuid } from '@peblish/schema/ids';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';
import { notifications } from '../notifications/tables.ts';
import type { NotificationKind } from '../notifications/view.ts';
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
export type PersonalTable = (typeof personalTables)[number];

/** The notice kinds the personal features write: a followed thread's comment, a remote community's Accept. */
export const personalNoticeKinds = ['thread_reply', 'follow_accept'] as const satisfies readonly NotificationKind[];

/**
 * Deletes everything the personal features hold for `ownerId`, in the caller's transaction: their
 * rows in `tables` (all of personalTables unless a restored backup lacks some), and their notices
 * (deletePersonalNotices). Older kinds are left to the notifications consumer, as before. Both
 * account deletion and its restore replay run this, so the two cannot drift apart.
 */
export async function deletePersonalData(db: WriteTx, ownerId: Uuid, tables: readonly PersonalTable[] = personalTables): Promise<void> {
  for (const table of tables) await db.delete(table).where(eq(table.ownerId, ownerId));
  await deletePersonalNotices(db, ownerId);
}

/**
 * Deletes the notices of the personal kinds that are `personId`'s or name them (another
 * follower's notice of their comment). Account deletion runs it, and the notifications consumer
 * again when it reads the deletion: that consumer handles events in commit order, so it comes
 * after every fan-out that could still have been writing such a notice when the account went.
 */
export async function deletePersonalNotices(db: WriteTx, personId: Uuid): Promise<void> {
  await db
    .delete(notifications)
    .where(
      and(
        inArray(notifications.kind, [...personalNoticeKinds]),
        or(eq(notifications.recipientId, personId), eq(notifications.actorId, personId)),
      ),
    );
}
