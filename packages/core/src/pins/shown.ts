import type { Uuid } from '@peblish/schema/ids';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { communityPins } from './tables.ts';

/**
 * Every pin of the owner in stored order, each marked `shown` when the sidebar lists it: the
 * owner still follows the community (accepted or pending) and it is open (not deleted, not
 * removed), the same rule as feeds/shell.ts. One query; the moves translate shown places with it.
 */
export async function shownPins(q: Queryable, ownerId: Uuid) {
  return q
    .select({
      communityId: communityPins.communityId,
      position: communityPins.position,
      shown: sql<boolean>`(${actors.kind} = 'Group' and ${isNull(actors.deletedAt)}
        and not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})
        and exists (select 1 from ${follows} where ${follows.followerId} = ${communityPins.ownerId} and ${follows.followeeId} = ${actors.id}))`,
    })
    .from(communityPins)
    .innerJoin(actors, eq(actors.id, communityPins.communityId))
    .where(eq(communityPins.ownerId, ownerId))
    .orderBy(asc(communityPins.position), asc(communityPins.communityId));
}
