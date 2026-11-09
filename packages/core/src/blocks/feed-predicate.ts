import { sql } from 'drizzle-orm';
import { posts } from '../db/tables/content.ts';
import type { FeedPredicate } from '../registry/types.ts';
import { communityBlocks, instanceBlocks, personBlocks } from './tables.ts';

/**
 * S02, blocks in every feed: a signed-in viewer does not see posts by a person they blocked,
 * posts in a community they blocked, or posts by or in anything on an instance they blocked.
 * Signed-out viewers block nothing.
 *
 * Each blocked set is read once per query into an array (`array(select ...)`, an InitPlan) and
 * tested with `<> all(...)`. Postgres estimates that as keeping nearly every post, which is
 * true; a `not in (select ...)` is estimated to keep half, so two of them made a Subscribed
 * page read every post of the followed communities instead of walking the date index
 * (feeds/perf.test.ts). The arrays are bounded by blocks/limits.ts. A community on a blocked
 * instance joins the community array (only Groups hold posts); the author's instance is looked
 * up per post only for a viewer with an instance block.
 */
export const feedPredicate: FeedPredicate = {
  name: 'blocks',
  where(viewer) {
    if (!viewer) return undefined;
    const me = viewer.actorId;
    return sql`(
      ${posts.authorId} <> all(array(select ${personBlocks.blockedId} from ${personBlocks} where ${personBlocks.blockerId} = ${me}))
      and ${posts.communityId} <> all(array(
        select ${communityBlocks.communityId} from ${communityBlocks} where ${communityBlocks.blockerId} = ${me}
        union all
        select blocked_community.id from ${instanceBlocks} as ib join actors as blocked_community on blocked_community.instance_id = ib.instance_id
        where ib.blocker_id = ${me} and blocked_community.kind = 'Group'
      ))
      and (
        not exists (select 1 from ${instanceBlocks} where ${instanceBlocks.blockerId} = ${me})
        or (select author_actor.instance_id from actors as author_actor where author_actor.id = ${posts.authorId})
          <> all(array(select ${instanceBlocks.instanceId} from ${instanceBlocks} where ${instanceBlocks.blockerId} = ${me}))
      )
    )`;
  },
};
