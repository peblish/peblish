import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { notBlocked } from './blocked.ts';
import { notifications } from './tables.ts';

/**
 * The one condition that decides which of `viewerId`'s notices exist for them: their own, not a
 * blocked author's reply or mention, and not in a community that has been deleted or removed.
 * The inbox list, its filter counts, the unread count and the sidebar badge all use it, so the
 * badge never counts a notice the inbox does not show. The community is tested by correlated
 * sub-selects on primary keys (no join), so the unread count still reads only its index; the
 * column is spelled out for the reason noticeBlocked (blocked.ts) gives.
 */
export const inboxVisible = (viewerId: Uuid): SQL =>
  and(
    eq(notifications.recipientId, viewerId),
    notBlocked(viewerId),
    sql`("notifications"."community_id" is null or exists (
      select 1 from ${actors} as notice_community
      where notice_community.id = "notifications"."community_id" and notice_community.deleted_at is null
        and not exists (select 1 from ${communityRemovals} as notice_removal where notice_removal.community_id = notice_community.id)
    ))`,
  )!;
