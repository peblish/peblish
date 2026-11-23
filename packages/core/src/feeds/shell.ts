import type { Uuid } from '@peblish/schema/ids';
import type { ShellCommunity } from '@peblish/schema/views';
import { and, count, eq, isNull, not, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { communityBlockedBy } from '../blocks/predicate.ts';
import { listLocalCommunities } from '../communities/read.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { peerBlocked } from '../peers/gate.ts';
import { pinnedFirst, pinsAmong } from '../pins/pins.ts';
import { ageClear } from '../posts/feed-predicate.ts';

// The lists the sidebar shows beyond its fixed links (web's shell/data.ts calls this).

export type SidebarCommunities = {
  /** Each with the viewer's follow state ('none' when signed out) and pin (pins.ts). */
  local: ShellCommunity[];
  remote: ShellCommunity[];
  /** How many communities the viewer moderates now; the Moderating feed link shows above 0. */
  moderating: number;
};

/** The most communities the sidebar lists, pinned ones first, then by name: it is sent with every page, so it stays bounded. */
const sidebarLimit = 500;

const open = and(
  isNull(actors.deletedAt),
  sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`,
);

/**
 * A signed-in viewer's communities: the ones they follow, local and remote, with a follow that
 * is still pending included (the Subscribed feed shows only the accepted ones), plus how many
 * they moderate. As everywhere else, a sensitive or NSFL one only once they declared 16+, none on
 * a host this server blocks, and none the viewer blocks, itself or through its host (the
 * directory's rule). One that opted out of search is still listed: the
 * choice keeps it out of the directory, and its follower found it already. A signed-out viewer
 * gets the local communities that are not age-gated.
 */
export async function sidebarCommunities(viewerId: Uuid | null, q: Queryable = db()): Promise<SidebarCommunities> {
  if (!viewerId) {
    const listed = await listLocalCommunities({ limit: sidebarLimit }, q);
    const local = listed.map(({ actor }): ShellCommunity => ({ ...actor, followState: 'none', pinned: false, pinPosition: null }));
    return { local, remote: [], moderating: 0 };
  }
  // What the joined list and the count of roles both keep to: the feeds' age gate (ageClear), and
  // the directory's block rules (this server's for a host, the viewer's own).
  const shown = and(
    ageClear(sql`(${actors.sensitive} or ${actors.nsfl})`, { actorId: viewerId }),
    not(peerBlocked(actors.instanceId)),
    not(communityBlockedBy(viewerId, { id: actors.id, instanceId: actors.instanceId })),
  );
  const [followed, [moderated]] = await Promise.all([
    q
      .select({
        id: actors.id,
        apId: actors.apId,
        kind: actors.kind,
        name: actors.name,
        displayName: actors.displayName,
        local: actors.local,
        host: instances.domain,
        followState: follows.state,
      })
      .from(follows)
      .innerJoin(actors, eq(actors.id, follows.followeeId))
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      // shownPins (pins/shown.ts) repeats this rule for the pins: a condition added here goes there too.
      .where(and(eq(follows.followerId, viewerId), eq(actors.kind, 'Group'), open, shown))
      .orderBy(pinnedFirst(viewerId, actors.id), sql`lower(${actors.name})`, actors.id)
      .limit(sidebarLimit),
    q
      .select({ moderating: count() })
      .from(communityModerators)
      .innerJoin(actors, eq(actors.id, communityModerators.communityId))
      .where(and(eq(communityModerators.moderatorId, viewerId), eq(actors.kind, 'Group'), open, freshModerator, shown)),
  ]);
  const pins = await pinsAmong(
    viewerId,
    followed.map(({ id }) => id),
    q,
  );
  const refs = followed.map(({ host, ...row }): ShellCommunity => ({
    ...row,
    handle: row.local ? row.name : `${row.name}@${host}`,
    pinned: pins.has(row.id),
    pinPosition: pins.get(row.id) ?? null,
  }));
  return { local: refs.filter(({ local }) => local), remote: refs.filter(({ local }) => !local), moderating: moderated?.moderating ?? 0 };
}
