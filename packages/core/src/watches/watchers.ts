import type { Uuid } from '@peblish/schema/ids';
import { sql } from 'drizzle-orm';
import { actorBlockedBy } from '../blocks/predicate.ts';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { noticeBlocked } from '../notifications/blocked.ts';
import { threadWatches } from './tables.ts';

// Who a new comment in a followed thread is news for (lane f-notify). The notifications consumer
// asks once per comment.created and writes each follower a `thread_reply` notice.

/**
 * Most followers one comment tells, so one event's batch stays small however many follow a
 * thread. The earliest followers come first, so a replay picks the same ones; the rest of a
 * thread that popular hear nothing of that comment.
 */
export const threadReplyFanOut = 200;

/**
 * The followers of the comment's thread who may be told of it, in one query: the comment, its post
 * and its community are live (neither deleted nor removed); the follow started before this server
 * received the comment (`since` before `comments.created_at`); the follower is a live local person
 * who is not its author, not in `told` (already given a reply or mention for it), does not block
 * its author or community (noticeBlocked, the inbox's rule) nor the post's author (actorBlockedBy:
 * the notice names the post), and has declared 16+ when the post or community is sensitive or
 * NSFL. None for a comment that is gone. The inbox rechecks the same when it lists the notice
 * (notifications/visible.ts).
 */
export async function threadFollowersOf(q: Queryable, commentId: Uuid, told: readonly Uuid[]): Promise<Uuid[]> {
  const blocked = noticeBlocked(sql`tw.owner_id`, { actorId: sql`c.author_id`, communityId: sql`p.community_id` });
  const notTold =
    told.length === 0
      ? sql`true`
      : sql`tw.owner_id not in (${sql.join(
          told.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const rows = await q.execute<{ id: Uuid }>(sql`
    select tw.owner_id as id
    from ${comments} as c
    join ${posts} as p on p.id = c.post_id
    join ${actors} as community on community.id = p.community_id
    join ${threadWatches} as tw on tw.post_id = p.id
    join ${actors} as follower on follower.id = tw.owner_id
    where c.id = ${commentId}::uuid
      and c.deleted_at is null and c.removed_at is null
      and p.deleted_at is null and p.removed_at is null
      and community.deleted_at is null
      and not exists (select 1 from ${communityRemovals} as removal where removal.community_id = community.id)
      and tw.since < c.created_at
      and tw.owner_id <> c.author_id
      and follower.kind = 'Person' and follower.local and follower.deleted_at is null
      and ${notTold}
      and not ${blocked}
      and not ${actorBlockedBy(sql`tw.owner_id`, sql`p.author_id`)}
      and (
        not (p.sensitive or p.nsfl or community.sensitive or community.nsfl)
        or exists (select 1 from ${ageDeclarations} as declared where declared.actor_id = tw.owner_id)
      )
    order by tw.since, tw.owner_id
    limit ${threadReplyFanOut}
  `);
  return rows.map((row) => row.id);
}
