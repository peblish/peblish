import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { localInstance } from '../db/local-instance.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { siteBans } from './tables.ts';

// Read models of the moderation UI (lane MODF): the site ban list, the counts a ban's
// confirmation shows, the communities someone moderates, and a handle's actor.

const columns = {
  id: actors.id,
  apId: actors.apId,
  kind: actors.kind,
  name: actors.name,
  displayName: actors.displayName,
  local: actors.local,
  domain: instances.domain,
};

type Row = { id: Uuid; apId: string; kind: ActorRef['kind']; name: string; displayName: string | null; local: boolean; domain: string };

const refOf = (row: Row): ActorRef => ({
  id: row.id,
  apId: row.apId,
  kind: row.kind,
  name: row.name,
  displayName: row.displayName,
  local: row.local,
  handle: row.local ? row.name : `${row.name}@${row.domain}`,
});

/** The communities this person moderates now (a local row until it expires, a remote mirror while verified), by handle. */
export async function moderatedCommunities(viewerId: Uuid, q: Queryable = readDb()): Promise<ActorRef[]> {
  const rows = await q
    .select(columns)
    .from(communityModerators)
    .innerJoin(actors, eq(actors.id, communityModerators.communityId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(and(eq(communityModerators.moderatorId, viewerId), freshModerator, eq(actors.kind, 'Group'), isNull(actors.deletedAt)))
    .orderBy(actors.name);
  return rows.map(refOf);
}

/**
 * The actor of a kind a handle names: `name` for a local actor, `name@host` for a remote one we
 * hold (a leading @ or ! is ignored; a local one may also be written `name@<this host>`). Null
 * when we hold none, or the actor is deleted. A list of kinds finds any of them (a site ban takes
 * a Person or a Service).
 */
export async function findActorByHandle(
  handle: string,
  kind: 'Person' | 'Group' | readonly ('Person' | 'Service')[],
  q: Queryable = readDb(),
): Promise<ActorRef | null> {
  const kinds = typeof kind === 'string' ? [kind] : kind;
  const [name, host, extra] = handle.trim().replace(/^[@!]/, '').split('@');
  if (!name || extra !== undefined) return null;
  const { origin } = await localInstance(q);
  const local = host === undefined || host.toLowerCase() === new URL(origin).host;
  const [row] = await q
    .select(columns)
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        inArray(actors.kind, kinds),
        isNull(actors.deletedAt),
        sql`lower(${actors.name}) = ${name.toLowerCase()}`,
        local ? eq(actors.local, true) : eq(instances.domain, host!.toLowerCase()),
      ),
    )
    // Local names are unique across kinds; a remote host's could repeat, so the first kind asked for wins.
    .orderBy(sql`${actors.kind} <> ${kinds[0]}`)
    .limit(1);
  return row ? refOf(row) : null;
}

export type SiteBanRow = {
  person: ActorRef;
  /** The person's instance (its domain). */
  home: string;
  reason: string | null;
  bannedBy: ActorRef | null;
  source: 'local' | 'remote';
  removeContent: boolean;
  createdAt: string;
  /** Null for a permanent ban. */
  expiresAt: string | null;
};

/** The site bans in force, newest first. */
export async function listSiteBans(q: Queryable = readDb()): Promise<SiteBanRow[]> {
  const rows = await q
    .select({ ...columns, ban: siteBans })
    .from(siteBans)
    .innerJoin(actors, eq(actors.id, siteBans.actorId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(or(isNull(siteBans.expiresAt), gt(siteBans.expiresAt, sql`now()`)))
    .orderBy(desc(siteBans.createdAt), desc(siteBans.actorId));
  const bannerIds = [...new Set(rows.flatMap((row) => (row.ban.bannedBy ? [row.ban.bannedBy] : [])))];
  const banners =
    bannerIds.length === 0
      ? []
      : await q.select(columns).from(actors).innerJoin(instances, eq(instances.id, actors.instanceId)).where(inArray(actors.id, bannerIds));
  const byId = new Map(banners.map((row) => [row.id, refOf(row)]));
  return rows.map((row) => ({
    person: refOf(row),
    home: row.domain,
    reason: row.ban.reason,
    bannedBy: row.ban.bannedBy ? (byId.get(row.ban.bannedBy) ?? null) : null,
    source: row.ban.source,
    removeContent: row.ban.removeContent,
    createdAt: row.ban.createdAt.toISOString(),
    expiresAt: row.ban.expiresAt?.toISOString() ?? null,
  }));
}

/**
 * How much a ban with "Also remove their content" would remove: the person's live posts and
 * comments in one community, or everywhere without `communityId`. The same rows the ban's
 * removal touches, counted for the confirmation.
 */
export async function contentCounts(
  actorId: Uuid,
  communityId?: Uuid,
  q: Queryable = readDb(),
): Promise<{ posts: number; comments: number }> {
  const livePosts = and(
    eq(posts.authorId, actorId),
    isNull(posts.removedAt),
    isNull(posts.deletedAt),
    communityId ? eq(posts.communityId, communityId) : undefined,
  );
  const inCommunity = communityId
    ? inArray(comments.postId, q.select({ id: posts.id }).from(posts).where(eq(posts.communityId, communityId)))
    : undefined;
  const [[postCount], [commentCount]] = await Promise.all([
    q.select({ n: count() }).from(posts).where(livePosts),
    q
      .select({ n: count() })
      .from(comments)
      .where(and(eq(comments.authorId, actorId), isNull(comments.removedAt), isNull(comments.deletedAt), inCommunity)),
  ]);
  return { posts: postCount?.n ?? 0, comments: commentCount?.n ?? 0 };
}
