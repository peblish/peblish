import type { Uuid } from '@peblish/schema/ids';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';

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
  communityId: Uuid;
  apId: string;
  name: string;
  displayName: string | null;
  local: boolean;
  state: 'pending' | 'accepted';
};

/** The communities `actorId` follows, pending ones included, by name; for the sidebar. Deleted communities are left out. */
export async function followedCommunities(actorId: Uuid): Promise<FollowedCommunity[]> {
  return db()
    .select({
      communityId: actors.id,
      apId: actors.apId,
      name: actors.name,
      displayName: actors.displayName,
      local: actors.local,
      state: follows.state,
    })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followeeId))
    .where(and(eq(follows.followerId, actorId), eq(actors.kind, 'Group'), isNull(actors.deletedAt)))
    .orderBy(asc(actors.name));
}
