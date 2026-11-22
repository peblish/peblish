import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { communityBlocks, instanceBlocks } from '../blocks/tables.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { peerControls } from '../peers/tables.ts';
import type { Viewer } from '../posts/read.ts';

// The profile rail's Moderates (Commons, branch 5): the communities the profile's subject
// moderates, for any viewer. Apart from `moderatedCommunities` in read.ts, which is where the
// viewer moderates and the subject posted.

/** The most communities the list names; `more` says when there are others. */
export const moderatesMax = 20;

export type Moderates = { communities: ActorRef[]; more: boolean };

/**
 * The communities `subjectId` moderates now, by name. Only a role that grants on this server
 * counts (`freshModerator`: appointed here and unexpired, or a remote community's row this server
 * verified and that has not expired; never a site-banned person). A community is listed only when
 * this viewer may see it: not deleted, not removed by an admin, listed in the directory
 * (discoverable), not on a blocked peer, not blocked by the viewer (itself or its instance), and,
 * when flagged sensitive or NSFL, only for a signed-in viewer who declared 16+ (the feeds' gate).
 */
export async function readModerates(subjectId: Uuid, viewer: Viewer, q: Queryable = db()): Promise<Moderates> {
  const rows = await q
    .select({
      id: actors.id,
      apId: actors.apId,
      kind: actors.kind,
      name: actors.name,
      displayName: actors.displayName,
      local: actors.local,
      domain: instances.domain,
    })
    .from(communityModerators)
    .innerJoin(actors, eq(actors.id, communityModerators.communityId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(communityModerators.moderatorId, subjectId),
        freshModerator,
        eq(actors.kind, 'Group'),
        isNull(actors.deletedAt),
        eq(actors.discoverable, true),
        sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`,
        sql`not exists (select 1 from ${peerControls} where ${peerControls.instanceId} = ${actors.instanceId} and ${peerControls.blocked})`,
        viewer
          ? sql`not exists (select 1 from ${communityBlocks} where ${communityBlocks.blockerId} = ${viewer.actorId} and ${communityBlocks.communityId} = ${actors.id})
            and not exists (select 1 from ${instanceBlocks} where ${instanceBlocks.blockerId} = ${viewer.actorId} and ${instanceBlocks.instanceId} = ${actors.instanceId})`
          : undefined,
        viewer
          ? sql`(not (${actors.sensitive} or ${actors.nsfl}) or exists (select 1 from ${ageDeclarations} where ${ageDeclarations.actorId} = ${viewer.actorId}))`
          : sql`not (${actors.sensitive} or ${actors.nsfl})`,
      ),
    )
    .orderBy(sql`lower(${actors.name})`, instances.domain)
    .limit(moderatesMax + 1);
  const communities = rows.slice(0, moderatesMax).map(({ domain, ...row }) => ({
    id: row.id,
    apId: row.apId,
    kind: row.kind,
    name: row.name,
    displayName: row.displayName,
    local: row.local,
    handle: row.local ? row.name : `${row.name}@${domain}`,
  }));
  return { communities, more: rows.length > moderatesMax };
}
