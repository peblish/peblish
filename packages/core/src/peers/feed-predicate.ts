import { sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import type { FeedPredicate } from '../registry/types.ts';
import { peerControls } from './tables.ts';

/**
 * A blocked peer's posts stay out of every feed (M18), whether its person wrote them or its
 * community holds them. Both sides are uncorrelated sub-selects that Postgres builds once per
 * query and probes by hash (a blocked peer is rare, and its communities are few): the post's own
 * instance is the author's (a peer's object lives on its author's origin), and a community is a
 * Group on a blocked instance. A correlated lookup per scanned row doubled the cost of the Hot
 * feed (feeds/perf.test.ts). The post page, which is reached by a link, still opens.
 */
export const feedPredicate: FeedPredicate = {
  name: 'blocked-peers',
  where() {
    const blocked = sql`select ${peerControls.instanceId} from ${peerControls} where ${peerControls.blocked}`;
    return sql`${posts.instanceId} not in (${blocked})
      and ${posts.communityId} not in (select ${actors.id} from ${actors} where ${actors.kind} = 'Group' and ${actors.instanceId} in (${blocked}))`;
  },
};
