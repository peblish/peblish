import type { Uuid } from '@peblish/schema/ids';
import { and, count, inArray, isNull, type SQL } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { notifications } from './tables.ts';
import { unreadCap, type NotificationKind } from './view.ts';
import { inboxVisible } from './visible.ts';

/** One person's unread notices that the inbox lists (inboxVisible), of these kinds when given: what every count shares. */
export const unreadWhere = (viewerId: Uuid, kinds?: readonly NotificationKind[]): SQL | undefined =>
  and(inboxVisible(viewerId), isNull(notifications.readAt), kinds && inArray(notifications.kind, [...kinds]));

/** The count's query: a capped subselect, so it probes at most unreadCap index entries. */
export function unreadCountQuery(q: Queryable, viewerId: Uuid, kinds?: readonly NotificationKind[]) {
  const unread = q.select({ one: notifications.id }).from(notifications).where(unreadWhere(viewerId, kinds)).limit(unreadCap).as('unread');
  return q.select({ n: count() }).from(unread);
}

/** How many of them there are, counting at most unreadCap. */
export async function unreadCountOf(q: Queryable, viewerId: Uuid, kinds?: readonly NotificationKind[]): Promise<number> {
  const [row] = await unreadCountQuery(q, viewerId, kinds);
  return row?.n ?? 0;
}

/**
 * The viewer's unread notices, at most unreadCap (view.ts); 0 when signed out (`viewerId`
 * null), with no query. The shell asks once per page load, so it reads only the unread index
 * (`notifications_unread`) and stops at the cap however many a person has let pile up.
 */
export const unreadCount = (viewerId: Uuid | null, q: Queryable = db()): Promise<number> =>
  viewerId === null ? Promise.resolve(0) : unreadCountOf(q, viewerId);
