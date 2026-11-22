import type { Uuid } from '@peblish/schema/ids';
import { and, asc, eq, isNull, not, sql } from 'drizzle-orm';
import { communityBlockedBy } from '../blocks/predicate.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { peerBlocked } from '../peers/gate.ts';

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
 * The communities `actorId` follows, pending ones included, by name; for the composer's picker.
 * Deleted and removed communities are left out, as are those on a host this server blocks and
 * those the person blocks, itself or through its host (the directory's rule). `accepted` leaves out pending follows,
 * `includeSensitive: false` the age-gated communities, and `limit` keeps the first by name.
 */
export async function followedCommunities(
  actorId: Uuid,
  options: { accepted?: boolean; includeSensitive?: boolean; limit?: number } = {},
): Promise<FollowedCommunity[]> {
  const query = db()
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
        not(peerBlocked(actors.instanceId)),
        not(communityBlockedBy(actorId, { id: actors.id, instanceId: actors.instanceId })),
        options.accepted ? eq(follows.state, 'accepted') : undefined,
        options.includeSensitive === false ? and(eq(actors.sensitive, false), eq(actors.nsfl, false)) : undefined,
      ),
    )
    // One name on several hosts comes by host, then id, so every read lists them alike.
    .orderBy(asc(actors.name), asc(instances.domain), asc(actors.id))
    .$dynamic();
  return options.limit === undefined ? query : query.limit(options.limit);
}
