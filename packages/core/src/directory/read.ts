import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { sanitizeRemoteHtml } from '../markdown/sanitize.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { blockedHosts } from '../resolve/blocked.ts';
import { parseLookup } from '../resolve/parse.ts';
import { effectiveNsfw, maxPage, pageSize, type DirectoryQuery } from './input.ts';
import { actorRef } from './ref.ts';

// The community directory (lane DISC): every community this server knows, local and remote, with
// the figures this server itself keeps. A remote community's own subscriber and post totals are
// stored nowhere (its Group document carries none), so `subscribers` is the people here who
// joined, and `active` the authors of its posts in this server's copy.

export type DirectoryViewer = { actorId: Uuid; declared: boolean } | null;

export type DirectoryRow = {
  actor: ActorRef;
  /** Plain text, sanitised from the community's summary; null when it has none. */
  excerpt: string | null;
  sensitive: boolean;
  nsfl: boolean;
  /** People on this server who joined (accepted follows). */
  subscribers: number;
  /** Distinct authors of live posts in the last 7 days in this server's copy. */
  active: number;
  /** When the copy of a remote community was last fetched (ISO); null for a local one. */
  refreshedAt: string | null;
  /** The viewer's own follow: none when signed out. */
  follow: 'none' | 'pending' | 'accepted';
};

export type Directory = {
  rows: DirectoryRow[];
  /** How many communities each scope lists under the viewer's NSFW setting and search. */
  counts: { local: number; all: number };
  page: number;
  hasNext: boolean;
};

const excerptLength = 160;
/** Enough of a summary to take an excerpt from. */
const excerptSource = 4000;

const subscribers = sql<number>`(select count(*)::int from follows where follows.followee_id = actors.id and follows.state = 'accepted')`;
// The posts_community_published index answers this from the newest post back.
const active = sql<number>`(select count(distinct posts.author_id)::int from posts where posts.community_id = actors.id
  and posts.published_at > now() - interval '7 days' and posts.deleted_at is null and posts.removed_at is null)`;
const published = sql`coalesce(${actors.publishedAt}, ${actors.createdAt})`;
const flagged = sql`(${actors.sensitive} or ${actors.nsfl})`;

/** `%`, `_` and `\` in a search are text, not patterns. */
const like = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

async function conditions(query: DirectoryQuery, viewer: DirectoryViewer): Promise<SQL> {
  const blocked = await blockedHosts();
  const nsfw = effectiveNsfw(query, viewer);
  // A remote Group flagged sensitive or nsfl is never listed (remote NSFW is rejected by default); a local one only for a declared viewer.
  const flaggedRule =
    nsfw === 'hide'
      ? sql`not ${flagged}`
      : nsfw === 'show'
        ? sql`(not ${flagged} or ${actors.local})`
        : sql`(${flagged} and ${actors.local})`;
  // A search that is a handle or a link is a resolve, not a filter: the list stays whole.
  const term = query.q !== '' && parseLookup(query.q) === null ? like(query.q) : null;
  return and(
    eq(actors.kind, 'Group'),
    // A community that opted out of search (the form's discoverable, or a peer's) is not listed.
    eq(actors.discoverable, true),
    isNull(actors.deletedAt),
    sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`,
    blocked.length > 0 ? notInArray(instances.domain, blocked) : undefined,
    flaggedRule,
    term === null
      ? undefined
      : or(
          sql`${actors.name} ilike ${term} escape '\\'`,
          sql`${actors.displayName} ilike ${term} escape '\\'`,
          sql`${instances.domain} ilike ${term} escape '\\'`,
        ),
  )!;
}

const order = {
  subscribers: sql`"subscribers" desc`,
  active: sql`"active" desc`,
  newest: sql`${published} desc`,
  name: sql`lower(${actors.name})`,
} as const;

/**
 * One page of the directory. Listed: Groups that are discoverable, not deleted, not removed by an
 * admin and not on a blocked host; none that is flagged sensitive or nsfl unless it is local and the viewer
 * declared 16+ and asked for NSFW. Ordered by the sort key, then name, then id, so a page boundary
 * never repeats or skips a row; paged by offset to 500 rows. A `q` that parses as a handle or a
 * link filters nothing.
 */
export async function listCommunities(query: DirectoryQuery, viewer: DirectoryViewer, q: Queryable = readDb()): Promise<Directory> {
  const page = Math.min(Math.max(Math.trunc(query.page), 1), maxPage);
  const where = await conditions(query, viewer);
  const [counted, found] = await Promise.all([
    q
      .select({ all: sql<number>`count(*)::int`, local: sql<number>`(count(*) filter (where ${actors.local}))::int` })
      .from(actors)
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      .where(where),
    q
      .select({
        id: actors.id,
        apId: actors.apId,
        kind: actors.kind,
        name: actors.name,
        displayName: actors.displayName,
        local: actors.local,
        host: instances.domain,
        summaryHtml: actors.summaryHtml,
        sensitive: actors.sensitive,
        nsfl: actors.nsfl,
        fetchedAt: actors.fetchedAt,
        subscribers: subscribers.as('subscribers'),
        active: active.as('active'),
      })
      .from(actors)
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      .where(and(where, query.scope === 'local' ? eq(actors.local, true) : undefined))
      .orderBy(order[query.sort], sql`lower(${actors.name})`, actors.id)
      .limit(pageSize + 1)
      .offset((page - 1) * pageSize),
  ]);
  const counts = { all: counted[0]?.all ?? 0, local: counted[0]?.local ?? 0 };
  const rows = found.slice(0, pageSize);

  const mine = new Map<string, 'pending' | 'accepted'>();
  if (viewer && rows.length > 0) {
    const own = await q
      .select({ followeeId: follows.followeeId, state: follows.state })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, viewer.actorId),
          inArray(
            follows.followeeId,
            rows.map((row) => row.id),
          ),
        ),
      );
    for (const { followeeId, state } of own) mine.set(followeeId, state);
  }
  return {
    rows: rows.map((row) => ({
      actor: actorRef(row),
      excerpt:
        row.summaryHtml === null
          ? null
          : sanitizeRemoteHtml(row.summaryHtml, { baseUrl: row.apId, images: 'link', maxLength: excerptSource, excerptLength }).excerpt ||
            null,
      sensitive: row.sensitive,
      nsfl: row.nsfl,
      subscribers: row.subscribers,
      active: row.active,
      refreshedAt: row.local ? null : (row.fetchedAt?.toISOString() ?? null),
      follow: mine.get(row.id) ?? 'none',
    })),
    counts,
    page,
    hasNext: found.length > pageSize && page < maxPage,
  };
}
