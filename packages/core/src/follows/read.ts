import type { Uuid } from '@peblish/schema/ids';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { communityRemovals } from '../moderation/tables.ts';

// Owned by lane FED-A. What the UI asks about follows: is this one pending, and what do I follow.

export type FollowState = 'none' | 'pending' | 'accepted';

/** The state of `actorId`'s follow of `communityId`: pending until the community's Accept arrives. */
export async function followState(actorId: Uuid, communityId: Uuid): Promise<FollowState> {
  const [row] = await db()
    .select({ state: follows.state })
    .from(follows)
    .where(and(eq(follows.followerId, actorId), eq(follows.followeeId, communityId)));
  return row?.state ?? 'none';
}

export type FollowedCommunity = {
  id: Uuid;
  apId: string;
  name: string;
  displayName: string | null;
  /** The community's server, lowercase, with the port when it is not the default: the handle's host. */
  host: string;
  local: boolean;
  state: 'pending' | 'accepted';
  postingRestrictedToMods: boolean;
  /** Age-gated (NSFW): a viewer who has not declared 16+ is not offered it. */
  sensitive: boolean;
  nsfl: boolean;
};

/**
 * The communities `actorId` follows, pending ones included, by name; for the sidebar and the
 * composer's picker. Deleted and removed communities are left out.
 */
export async function followedCommunities(actorId: Uuid): Promise<FollowedCommunity[]> {
  const rows = await db()
    .select({
      id: actors.id,
      apId: actors.apId,
      name: actors.name,
      displayName: actors.displayName,
      host: instances.domain,
      local: actors.local,
      state: follows.state,
      postingRestrictedToMods: actors.postingRestrictedToMods,
      sensitive: actors.sensitive,
      nsfl: actors.nsfl,
    })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followeeId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(follows.followerId, actorId),
        eq(actors.kind, 'Group'),
        isNull(actors.deletedAt),
        sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`,
      ),
    )
    .orderBy(asc(actors.name));
  return rows;
}
