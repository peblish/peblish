import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { notifications } from './tables.ts';
import { isReadBatch } from './view.ts';
import { defineMutation } from '../tx/mutation.ts';

// The inbox's five writes. A person's marks recheck, so a site-banned person writes nothing
// (auth.site_banned); the consumer's create and purge run as the instance and do not. None
// writes the acting actor's row. Targets come from grant.subject; the context ids a notice
// carries for rendering come in as input.

/** What a notice links to, for rendering. Plain ids: a purged row sets them null. */
export type NotificationContext = {
  actorId: Uuid | null;
  communityId: Uuid | null;
  postId: Uuid | null;
  commentId: Uuid | null;
  modlogId: Uuid | null;
};

/** Writes the notice, once per recipient and cause: a repeat writes nothing and emits nothing. Returns the new id, or null for a repeat. */
export const createNotification = defineMutation({
  action: 'notification.create',
  emits: ['notification.created'],
  async run(t, grant, context: NotificationContext) {
    const { recipientId, kind, refId } = grant.subject;
    const [row] = await t.db
      .insert(notifications)
      .values({ recipientId, kind, refId, ...context })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!row) return null;
    await t.emit({ type: 'notification.created', v: 1, notificationId: row.id, recipientId, kind });
    return row.id;
  },
});

/** Marks one of the owner's notices read, or unread; answers whether anything changed. */
export const markNotification = defineMutation({
  action: 'notification.read',
  emits: ['notification.read'],
  recheck: true,
  async run(t, grant, input: { read: boolean }) {
    const { notificationId } = grant.subject;
    const [row] = await t.db
      .update(notifications)
      .set({ readAt: input.read ? sql`now()` : null })
      .where(and(eq(notifications.id, notificationId), input.read ? isNull(notifications.readAt) : isNotNull(notifications.readAt)))
      .returning({ recipientId: notifications.recipientId });
    if (!row) return { changed: false };
    await t.emit({ type: 'notification.read', v: 1, recipientId: row.recipientId, notificationId, read: input.read, count: 1 });
    return { changed: true };
  },
});

/**
 * `read_at` in whole microseconds since the epoch, as text: what names a Mark all read for its
 * Undo. Every row one Mark all read changes gets the same `now()` (the transaction's), so the
 * stamp picks out exactly those rows; text, since a JS Date keeps only milliseconds.
 */
const readStamp = sql<string>`(extract(epoch from ${notifications.readAt}) * 1000000)::bigint::text`;

/**
 * Marks every unread notice of the owner read; answers how many it changed and `batch`, the
 * stamp its Undo takes (null when nothing was unread).
 */
export const markAllNotificationsRead = defineMutation({
  action: 'notification.read_all',
  emits: ['notification.read'],
  recheck: true,
  async run(t, grant) {
    const { recipientId } = grant.subject;
    const rows = await t.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
      .returning({ id: notifications.id, batch: readStamp });
    if (rows.length > 0) {
      await t.emit({ type: 'notification.read', v: 1, recipientId, notificationId: null, read: true, count: rows.length });
    }
    return { count: rows.length, batch: rows[0]?.batch ?? null };
  },
});

/**
 * Undoes one Mark all read: marks unread again exactly the owner's notices it marked read that are
 * still read from it. A notice that arrived since is unread and stays so; one the owner marked
 * unread, or read again, since then carries another stamp and is left as it is. Answers how many.
 */
export const undoMarkAllRead = defineMutation({
  action: 'notification.undo_read_all',
  emits: ['notification.read'],
  recheck: true,
  async run(t, grant, input: { batch: string }) {
    const { recipientId } = grant.subject;
    if (!isReadBatch(input.batch)) return { count: 0 };
    const rows = await t.db
      .update(notifications)
      .set({ readAt: null })
      .where(and(eq(notifications.recipientId, recipientId), isNotNull(notifications.readAt), sql`${readStamp} = ${input.batch}`))
      .returning({ id: notifications.id });
    if (rows.length > 0) {
      await t.emit({ type: 'notification.read', v: 1, recipientId, notificationId: null, read: false, count: rows.length });
    }
    return { count: rows.length };
  },
});

/** Removes every notice of a person whose account was deleted; answers how many. */
export const purgeNotifications = defineMutation({
  action: 'notification.purge',
  emits: ['notification.purged'],
  async run(t, grant) {
    const { recipientId } = grant.subject;
    const rows = await t.db.delete(notifications).where(eq(notifications.recipientId, recipientId)).returning({ id: notifications.id });
    if (rows.length > 0) await t.emit({ type: 'notification.purged', v: 1, recipientId, count: rows.length });
    return { count: rows.length };
  },
});
