import { sql } from 'drizzle-orm';
import { posts } from '../db/tables/content.ts';
import type { FeedPredicate } from '../registry/types.ts';
import { communityBlocks, instanceBlocks, personBlocks } from './tables.ts';

/**
 * S02, blocks in every feed: a signed-in viewer does not see posts by a person they blocked,
 * posts in a community they blocked, or posts by or in anything on an instance they blocked.
 * Signed-out viewers block nothing.
 *
 * Each sub-select depends only on the viewer, so Postgres hashes it once per query; the
 * correlated part is the post's own author_id and community_id. A viewer with no instance
 * block skips the actor lookups altogether. Nothing here adds an index to `posts`.
 */
export const feedPredicate: FeedPredicate = {
  name: 'blocks',
  where(viewer) {
    if (!viewer) return undefined;
    const me = viewer.actorId;
    const blockedInstances = sql`(select ${instanceBlocks.instanceId} from ${instanceBlocks} where ${instanceBlocks.blockerId} = ${me})`;
    return sql`(
      ${posts.authorId} not in (select ${personBlocks.blockedId} from ${personBlocks} where ${personBlocks.blockerId} = ${me})
      and ${posts.communityId} not in (select ${communityBlocks.communityId} from ${communityBlocks} where ${communityBlocks.blockerId} = ${me})
      and (
        not exists (select 1 from ${instanceBlocks} where ${instanceBlocks.blockerId} = ${me})
        or (
          (select author_actor.instance_id from actors as author_actor where author_actor.id = ${posts.authorId}) not in ${blockedInstances}
          and (select community_actor.instance_id from actors as community_actor where community_actor.id = ${posts.communityId}) not in ${blockedInstances}
        )
      )
    )`;
  },
};
