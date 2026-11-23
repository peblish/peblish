import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { feedPredicate as blocksRule } from '../blocks/feed-predicate.ts';
import { communityBlocks, personBlocks } from '../blocks/tables.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { feedPredicate as blockedPeersRule } from '../peers/feed-predicate.ts';
import { feedPredicate as nsfwGate } from '../posts/feed-predicate.ts';
import { feedPredicates } from '../registry/feed-predicates.gen.ts';
import { instanceBlockedBy, notBlocked, peerBlockedByKey } from './blocked.ts';
import { notifications } from './tables.ts';

// Every condition here runs once per notice, so it reads only the rows the notice names, by
// their keys (blocked.ts says how, read.test.ts checks the rows each statement visits).

/**
 * The feeds' rules (registry/feed-predicates.gen.ts) as a followed thread's notice applies them to
 * the one post its comment is on, from the rows followedThreadReadable joins by key: the post's
 * community (`post_community`) and author (`post_author`). The feeds read each blocked set whole,
 * once per query, which suits a page of posts but would be a pass over every actor or peer here.
 * A rule not named here applies as the feeds apply it.
 */
const threadRules: Record<string, (viewerId: Uuid) => SQL> = {
  // Its author, its community, a Group on a server the viewer blocks, and its author's server.
  [blocksRule.name]: (viewerId) => sql`
    not exists (select 1 from ${personBlocks} as pb where pb.blocker_id = ${viewerId} and pb.blocked_id = ${posts.authorId})
    and not exists (select 1 from ${communityBlocks} as cb where cb.blocker_id = ${viewerId} and cb.community_id = ${posts.communityId})
    and not (post_community.kind = 'Group' and ${instanceBlockedBy(viewerId, sql`post_community.instance_id`)})
    and not ${instanceBlockedBy(viewerId, sql`post_author.instance_id`)}`,
  // Its own server, and a Group on a blocked peer.
  [blockedPeersRule.name]: () =>
    sql`not ${peerBlockedByKey(posts.instanceId)} and not (post_community.kind = 'Group' and ${peerBlockedByKey(sql`post_community.instance_id`)})`,
  // As a signed-out viewer meets the gate, for the reason followedThreadReadable gives.
  [nsfwGate.name]: () => sql`not (${posts.sensitive} or ${posts.nsfl} or post_community.sensitive or post_community.nsfl)`,
};

/**
 * A followed thread's notice (`thread_reply`) exists for the viewer only while its comment is one
 * they may read and its row may say who wrote it: the comment and its post are live (not removed,
 * deleted or purged), its commenter's account is live and not on a peer this server blocks
 * (a deleted account's notices are cleared, identity/personal.ts), the post is not flagged
 * sensitive or NSFL, and it passes the feeds' other rules for this viewer (threadRules: blocks of
 * its author, its community or their servers, blocked peers). All but the blocks hold for every
 * viewer alike, so no row is ever anonymous: one would be, for a declared reader of flagged
 * content, and a block of its commenter would then tell who wrote it by the row's absence. The
 * NSFW gate is applied as a signed-out viewer meets it for that reason. Other kinds pass untouched.
 *
 * A scalar sub-select keyed by the notice's comment id, its post and their people and community
 * joined by their keys: Postgres may run an EXISTS as one hashed pass over every comment, and the
 * unread count, which runs on every signed-in page load, would then read the whole table.
 */
const followedThreadReadable = (viewerId: Uuid): SQL => {
  const rules = feedPredicates.flatMap(
    (predicate) => threadRules[predicate.name]?.(viewerId) ?? predicate.where({ actorId: viewerId }) ?? [],
  );
  return sql`("notifications"."kind" <> 'thread_reply' or coalesce((
    select true from ${comments} as notice_comment
    join ${actors} as notice_author on notice_author.id = notice_comment.author_id
    join ${posts} on ${posts.id} = notice_comment.post_id
    join ${actors} as post_community on post_community.id = ${posts.communityId}
    join ${actors} as post_author on post_author.id = ${posts.authorId}
    where notice_comment.id = "notifications"."comment_id"
      and notice_comment.deleted_at is null and notice_comment.removed_at is null
      and notice_author.deleted_at is null and not ${peerBlockedByKey(sql`notice_author.instance_id`)}
      and ${posts.deletedAt} is null and ${posts.removedAt} is null
      and ${sql.join(rules, sql` and `)}
  ), false))`;
};

/**
 * A follow's answer (`follow_accept`) names its community, so it exists for the viewer only while
 * the community is not on a peer this server blocks and the community gate opens it to them:
 * gateOf(flagged, { declared }, true) is 'none' for a community that is not sensitive or NSFL, or
 * for a viewer who declared 16+ (followed.test.ts checks the four cases against gateOf). In SQL,
 * so rows and counts share it, as a sub-select keyed by the community id. Other kinds pass.
 */
const followAcceptOpen = (viewerId: Uuid): SQL =>
  sql`("notifications"."kind" <> 'follow_accept' or coalesce((
    select not ${peerBlockedByKey(sql`accepted_community.instance_id`)}
      and (not (accepted_community.sensitive or accepted_community.nsfl)
        or exists (select 1 from ${ageDeclarations} where ${ageDeclarations.actorId} = ${viewerId}))
    from ${actors} as accepted_community where accepted_community.id = "notifications"."community_id"
  ), true))`;

/** SQL true when the community `communityId` names is live: neither deleted nor removed. False when there is no such row. */
const communityLive = (communityId: SQLWrapper): SQL<boolean> =>
  sql<boolean>`coalesce((
    select notice_community.deleted_at is null and not coalesce((
      select true from ${communityRemovals} as notice_removal where notice_removal.community_id = notice_community.id
    ), false)
    from ${actors} as notice_community where notice_community.id = ${communityId}
  ), false)`;

/**
 * The one condition that decides which of `viewerId`'s notices exist for them: their own, not a
 * blocked author's reply or mention (notBlocked), not in a community that has been deleted or
 * removed, no followed thread's notice whose comment they may not read (followedThreadReadable),
 * and no follow's answer for a community the age gate closes to them (followAcceptOpen).
 * The inbox list, its filter counts, the unread count and the sidebar badge all use it, so the
 * badge never counts a notice the inbox does not show. Every row it reads is read by key (no
 * join), so the unread count still reads only its index; the column is spelled out for the
 * reason noticeBlocked (blocked.ts) gives.
 */
export const inboxVisible = (viewerId: Uuid): SQL =>
  and(
    eq(notifications.recipientId, viewerId),
    notBlocked(viewerId),
    sql`("notifications"."community_id" is null or ${communityLive(sql`"notifications"."community_id"`)})`,
    followedThreadReadable(viewerId),
    followAcceptOpen(viewerId),
  )!;
