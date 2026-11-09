import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { notifications } from './tables.ts';
import { defineMutation } from '../tx/mutation.ts';

// The inbox's four writes. None sets recheck (nothing here is revoked by a ban or a lock), and
// none writes the acting actor's row. Targets come from grant.subject; the context ids a notice
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

/** Marks every unread notice of the owner read; answers how many it changed. */
export const markAllNotificationsRead = defineMutation({
  action: 'notification.read_all',
  emits: ['notification.read'],
  async run(t, grant) {
    const { recipientId } = grant.subject;
    const rows = await t.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    if (rows.length > 0) {
      await t.emit({ type: 'notification.read', v: 1, recipientId, notificationId: null, read: true, count: rows.length });
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
