import type { ActorRef } from '@peblish/schema/views';
import { and, eq, sql } from 'drizzle-orm';
import { blockedAmong } from '../blocks/predicate.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import type { DirectoryQuery } from './input.ts';
import { conditions, type DirectoryViewer } from './read.ts';
import { actorRef } from './ref.ts';

/** The most of a viewer's own communities one search returns, by name. */
const followedLimit = 100;

export type FollowedCommunity = { actor: ActorRef; follow: 'pending' | 'accepted' };

/**
 * The viewer's own communities, joined or asked to join, that the directory lists them under `query` (its
 * conditions: none deleted or removed, none on a blocked host, none withheld by its NSFW and age rule, and the
 * search), less the communities and instances the viewer blocked. Not paged by the directory: one of them may come
 * after its first page. By name, then id. The header's finder groups these as the viewer's own.
 */
export async function followedListed(
  query: DirectoryQuery,
  viewer: NonNullable<DirectoryViewer>,
  q: Queryable = readDb(),
): Promise<FollowedCommunity[]> {
  const rows = await q
    .select({
      id: actors.id,
      apId: actors.apId,
      kind: actors.kind,
      name: actors.name,
      displayName: actors.displayName,
      local: actors.local,
      host: instances.domain,
      follow: follows.state,
    })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followeeId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(and(eq(follows.followerId, viewer.actorId), await conditions(query, viewer)))
    .orderBy(sql`lower(${actors.name})`, actors.id)
    .limit(followedLimit);
  const blocked = await blockedAmong(
    q,
    viewer.actorId,
    rows.map(({ id }) => id),
  );
  return rows.filter(({ id }) => !blocked.has(id)).map(({ follow, ...row }) => ({ actor: actorRef(row), follow }));
}
