import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { listLocalCommunities } from '../communities/read.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { communityRemovals } from '../moderation/tables.ts';

// The lists the sidebar shows beyond its fixed links (web's shell/data.ts calls this).

export type SidebarCommunities = {
  local: ActorRef[];
  remote: ActorRef[];
  /** How many communities the viewer moderates now; the Moderating feed link shows above 0. */
  moderating: number;
};

/** The most communities the sidebar lists, by name: it is sent with every page, so it stays bounded. */
const sidebarLimit = 500;

const open = and(
  isNull(actors.deletedAt),
  sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`,
);

/**
 * A signed-in viewer's communities: the ones they follow, local and remote, with a follow that
 * is still pending included (the Subscribed feed shows only the accepted ones), plus how many
 * they moderate. A signed-out viewer gets the local communities that are not age-gated.
 */
export async function sidebarCommunities(viewerId: Uuid | null, q: Queryable = db()): Promise<SidebarCommunities> {
  if (!viewerId) {
    const listed = await listLocalCommunities({ limit: sidebarLimit }, q);
    return { local: listed.map(({ actor }) => actor), remote: [], moderating: 0 };
  }
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
      })
      .from(follows)
      .innerJoin(actors, eq(actors.id, follows.followeeId))
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      .where(and(eq(follows.followerId, viewerId), eq(actors.kind, 'Group'), open))
      .orderBy(sql`lower(${actors.name})`, actors.id)
      .limit(sidebarLimit),
    q
      .select({ moderating: count() })
      .from(communityModerators)
      .innerJoin(actors, eq(actors.id, communityModerators.communityId))
      .where(and(eq(communityModerators.moderatorId, viewerId), eq(actors.kind, 'Group'), open, freshModerator)),
  ]);
  const refs = followed.map(({ host, ...row }): ActorRef => ({ ...row, handle: row.local ? row.name : `${row.name}@${host}` }));
  return { local: refs.filter(({ local }) => local), remote: refs.filter(({ local }) => !local), moderating: moderated?.moderating ?? 0 };
}
