import { sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import type { FeedPredicate } from '../registry/types.ts';
import { peerControls } from './tables.ts';

/**
 * A blocked peer's posts stay out of every feed (M18), whether its person wrote them or its
 * community holds them. The post's own instance is the author's (a peer's object lives on its
 * author's origin), and a community is a Group on a blocked instance. Both sets are read once
 * per query into arrays and tested with `<> all(...)`, which Postgres estimates as keeping
 * nearly every post; a `not in (select ...)` is estimated to keep half, which turned the
 * Subscribed feed from an index walk into a read of every followed post (feeds/perf.test.ts).
 * A correlated lookup per scanned row doubled the cost of the Hot feed. The post page, which is
 * reached by a link, still opens.
 */
export const feedPredicate: FeedPredicate = {
  name: 'blocked-peers',
  where() {
    const blocked = sql`select ${peerControls.instanceId} from ${peerControls} where ${peerControls.blocked}`;
    return sql`${posts.instanceId} <> all(array(${blocked}))
      and ${posts.communityId} <> all(array(select ${actors.id} from ${actors} where ${actors.kind} = 'Group' and ${actors.instanceId} in (${blocked})))`;
  },
};
