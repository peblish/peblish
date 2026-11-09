import { inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { notifications } from './tables.ts';

/**
 * SQL true when the recipient has blocked the person who caused a reply or mention notice
 * (the person, their instance, or the community; lane E1's predicate). Removal and ban
 * notices are never blocked: the statement of reasons is owed. The consumer asks it with
 * values before it writes a notice; the list and the unread count ask it of each row.
 *
 * A seam: false until E1's predicate is merged and wired in here.
 */
export function noticeBlocked(_notice: {
  kind: SQLWrapper;
  recipientId: SQLWrapper;
  actorId: SQLWrapper;
  communityId: SQLWrapper;
}): SQL<boolean> {
  return sql`false`;
}

/** The condition a notices query adds so a blocked author's reply or mention never lists or counts. */
export const notBlocked = (): SQL =>
  sql`not (${inArray(notifications.kind, ['reply', 'mention'])} and ${noticeBlocked({ kind: notifications.kind, recipientId: notifications.recipientId, actorId: notifications.actorId, communityId: notifications.communityId })})`;
