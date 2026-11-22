import { type } from 'arktype';
import { Uuid } from '../ids.ts';
import { NoticeKind } from '../notices.ts';

// Owned by lane E2 (wave 3). The inbox: one row per notice (core notifications/tables.ts). The
// kinds are notices.ts's, a superset of core's notificationKinds, which this package cannot import.

export const events = {
  /** A notice was written. Not emitted for a repeat of one already held (same recipient and cause). */
  'notification.created': type({ type: "'notification.created'", v: '1', notificationId: Uuid, recipientId: Uuid, kind: NoticeKind }),
  /** The owner marked one notice (notificationId) or all of theirs (null) read or unread; count is the rows changed. */
  'notification.read': type({
    type: "'notification.read'",
    v: '1',
    recipientId: Uuid,
    notificationId: Uuid.or('null'),
    read: 'boolean',
    count: 'number.integer >= 0',
  }),
  /** A deleted person's notices were removed. */
  'notification.purged': type({ type: "'notification.purged'", v: '1', recipientId: Uuid, count: 'number.integer >= 0' }),
};
