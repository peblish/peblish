import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { instances } from '../db/tables/instances.ts';
import { followState, type FollowState } from '../follows/read.ts';
import { ageDeclarations } from '../identity/tables.ts';
import type { SanitizeHooks } from '../markdown/sanitize.ts';
import { communityBans, communityRemovals } from '../moderation/tables.ts';
import type { Viewer } from '../posts/read.ts';
import { shows, type NsfwChoice } from './gate.ts';
import { readCommunity, type CommunityDetail } from './read.ts';

// What the community page needs beyond the shared detail (lane COMM): the local counts, where the
// community lives, when this copy was last refreshed, every moderator row with how far to trust
// it, and what the viewer may do. A fixed handful of queries, none per row.

/**
 * How a moderator row stands: `local` (appointed here), `fresh` (a remote row its origin
 * verified, not expired), `stale` (expired: it grants nothing until refreshed) or `unknown`
 * (a remote row never verified: it grants nothing).
 */
export type ModeratorState = 'local' | 'fresh' | 'stale' | 'unknown';

export type PageModerator = {
  actor: ActorRef;
  role: 'owner' | 'moderator';
  state: ModeratorState;
  /** When the origin last confirmed the row (remote), else null. */
  verifiedAt: string | null;
  /** When this copy first listed them. */
  since: string;
};

export type CommunityPage = CommunityDetail & {
  /** Live posts held on this instance (not deleted, not removed): a remote community's peer total is not stored. */
  postCount: number;
  createdAt: string;
  /** When this copy of a remote community was last fetched from its home, else null. */
  fetchedAt: string | null;
  /** The community's server: the host of its handle. */
  home: string;
  moderators: PageModerator[];
  followState: FollowState;
  /** The viewer is banned from the community. */
  banned: boolean;
  /** The viewer may start a post here: not banned, and a restricted community admits only its staff. */
  canPost: boolean;
  /** The viewer is the community's owner or a moderator with a role that grants now, or a site admin. */
  canModerate: boolean;
};

const live = and(isNull(posts.deletedAt), isNull(posts.removedAt));

function stateOf(row: { source: 'local' | 'remote'; verifiedAt: Date | null; expiresAt: Date | null }): ModeratorState {
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  if (row.source === 'local') return expired ? 'stale' : 'local';
  if (!row.verifiedAt) return 'unknown';
  return expired ? 'stale' : 'fresh';
}

/**
 * One community for its page, or null when it is unknown, deleted or removed. `hooks` is
 * readCommunity's (remote summaries); the viewer's own state needs the viewer.
 */
export async function readCommunityPage(
  key: { id: Uuid },
  viewer: Viewer,
  q: Queryable = readDb(),
  hooks: SanitizeHooks = {},
): Promise<CommunityPage | null> {
  const detail = await readCommunity(key, q, hooks);
  if (!detail) return null;
  const id = detail.actor.id;
  const [[extra], moderators, [own], [ban], follow] = await Promise.all([
    q
      .select({
        home: instances.domain,
        fetchedAt: actors.fetchedAt,
        publishedAt: actors.publishedAt,
        createdAt: actors.createdAt,
        postCount: sql<number>`(select count(*)::int from ${posts} where ${posts.communityId} = ${actors.id} and ${live})`,
      })
      .from(actors)
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      .where(eq(actors.id, id)),
    q
      .select({
        id: actors.id,
        apId: actors.apId,
        kind: actors.kind,
        name: actors.name,
        displayName: actors.displayName,
        local: actors.local,
        host: instances.domain,
        role: communityModerators.role,
        source: communityModerators.source,
        verifiedAt: communityModerators.verifiedAt,
        expiresAt: communityModerators.expiresAt,
        since: communityModerators.createdAt,
      })
      .from(communityModerators)
      .innerJoin(actors, eq(actors.id, communityModerators.moderatorId))
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      .where(and(eq(communityModerators.communityId, id), isNull(actors.deletedAt)))
      .orderBy(sql`${communityModerators.role} = 'owner' desc`, asc(communityModerators.createdAt), asc(actors.id)),
    viewer
      ? q
          .select({ role: communityModerators.role })
          .from(communityModerators)
          .where(and(eq(communityModerators.communityId, id), eq(communityModerators.moderatorId, viewer.actorId), freshModerator))
      : [],
    viewer
      ? q
          .select({ actorId: communityBans.actorId })
          .from(communityBans)
          .where(
            and(
              eq(communityBans.communityId, id),
              eq(communityBans.actorId, viewer.actorId),
              sql`(${communityBans.expiresAt} is null or ${communityBans.expiresAt} > now())`,
            ),
          )
      : [],
    viewer ? followState(viewer.actorId, id) : ('none' as const),
  ]);
  if (!extra) return null;
  const banned = ban !== undefined;
  const canModerate = viewer?.siteRole === 'admin' || (own !== undefined && !banned);
  return {
    ...detail,
    postCount: extra.postCount,
    createdAt: (extra.publishedAt ?? extra.createdAt).toISOString(),
    fetchedAt: extra.fetchedAt?.toISOString() ?? null,
    home: extra.home,
    moderators: moderators.map((row) => ({
      actor: {
        id: row.id,
        apId: row.apId,
        kind: row.kind,
        name: row.name,
        displayName: row.displayName,
        local: row.local,
        handle: row.local ? row.name : `${row.name}@${row.host}`,
      },
      role: row.role,
      state: stateOf(row),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      since: row.since.toISOString(),
    })),
    followState: follow,
    banned,
    canPost: !banned && (!detail.postingRestrictedToMods || canModerate),
    canModerate,
  };
}

/** Where the gate stands for a community page: the same four answers as a post's `Gate`. */
export type CommunityGate = 'none' | 'sign-in' | 'age' | 'hidden';

/**
 * The NSFW gate for a whole community page, decided before anything about the community is read
 * for the page: 'none' when it is not flagged (or the viewer declared 16+ and chose to show it),
 * null when there is no live community to gate (the page is a 404). `age` and `sign-in` hold
 * back everything, as `hidden` does for a declared viewer with Hide NSFW on.
 */
export async function communityGate(
  communityId: Uuid,
  viewer: Viewer,
  nsfw: NsfwChoice,
  q: Queryable = readDb(),
): Promise<CommunityGate | null> {
  const [row] = await q
    .select({ sensitive: actors.sensitive, nsfl: actors.nsfl })
    .from(actors)
    .where(
      and(
        eq(actors.id, communityId),
        eq(actors.kind, 'Group'),
        isNull(actors.deletedAt),
        sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`,
      ),
    );
  if (!row) return null;
  if (!row.sensitive && !row.nsfl) return 'none';
  if (!viewer) return 'sign-in';
  const [declared] = await q
    .select({ actorId: ageDeclarations.actorId })
    .from(ageDeclarations)
    .where(eq(ageDeclarations.actorId, viewer.actorId));
  if (!declared) return 'age';
  return shows(nsfw, communityId) ? 'none' : 'hidden';
}
