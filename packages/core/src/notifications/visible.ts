import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { feedPredicates } from '../registry/feed-predicates.gen.ts';
import { notBlocked } from './blocked.ts';
import { notifications } from './tables.ts';

/**
 * A followed thread's notice (`thread_reply`) exists for the viewer only while its comment is one
 * they may read: the comment and its post are live (not removed, deleted or purged, for every
 * viewer alike) and the post passes the feeds' rules for this viewer (blocks of its author, its
 * community or their servers, blocked peers, the 16+ declaration). So a block of a withheld
 * comment's author changes nothing the viewer can see: the notice was left out already. Other
 * kinds pass untouched.
 */
const followedThreadReadable = (viewerId: Uuid): SQL => {
  const rules = feedPredicates.flatMap((predicate) => predicate.where({ actorId: viewerId }) ?? []);
  return sql`("notifications"."kind" <> 'thread_reply' or exists (
    select 1 from ${comments} as notice_comment join ${posts} on ${posts.id} = notice_comment.post_id
    where notice_comment.id = "notifications"."comment_id"
      and notice_comment.deleted_at is null and notice_comment.removed_at is null
      and ${posts.deletedAt} is null and ${posts.removedAt} is null
      and ${sql.join(rules, sql` and `)}
  ))`;
};

/**
 * A follow's answer (`follow_accept`) names its community, so it exists for the viewer only while
 * the community gate opens that community to them: gateOf(flagged, { declared }, true) is 'none'
 * for a community that is not sensitive or NSFL, or for a viewer who declared 16+ (followed.test.ts
 * checks the four cases against gateOf). In SQL, so rows and counts share it. Other kinds pass.
 */
const followAcceptOpen = (viewerId: Uuid): SQL =>
  sql`("notifications"."kind" <> 'follow_accept' or not exists (
    select 1 from ${actors} as accepted_community
    where accepted_community.id = "notifications"."community_id" and (accepted_community.sensitive or accepted_community.nsfl)
  ) or exists (select 1 from ${ageDeclarations} where ${ageDeclarations.actorId} = ${viewerId}))`;

/**
 * The one condition that decides which of `viewerId`'s notices exist for them: their own, not a
 * blocked author's reply or mention, not in a community that has been deleted or removed, no
 * followed thread's notice whose comment they may not read (followedThreadReadable), and no
 * follow's answer for a community the age gate closes to them (followAcceptOpen).
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
    followedThreadReadable(viewerId),
    followAcceptOpen(viewerId),
  )!;
