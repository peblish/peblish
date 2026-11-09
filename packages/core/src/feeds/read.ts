import type { Uuid } from '@peblish/schema/ids';
import type { Page, PostView } from '@peblish/schema/views';
import { and, asc, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { posts } from '../db/tables/content.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { postViews, type PostRow, type Viewer } from '../posts/read.ts';
import { feedPredicates } from '../registry/feed-predicates.gen.ts';
import { decodeCursor, encodeCursor, periodMs, type Cursor } from './cursor.ts';
import { defaultPageSize, defaultPeriod, maxPageSize, type FeedName, type Period, type Sort } from './input.ts';

// The feed read model (D01 feeds, D02 Hot, D04 New and Old, D05 Top by period). One query
// finds the page's keys (id and sort key, no wide columns), the posts are fetched by id, and
// postViews (posts/read.ts) turns them into views and withholds what a viewer may not see.
// There is no rank table and no refresh job: Hot is computed in the query over the week it
// ranks, against the clock the first page fixed (`asOf`, carried in the cursor).

export type FeedRequest = {
  feed: FeedName;
  sort: Sort;
  /** The window of Top; ignored by the other sorts. */
  period?: Period;
  /** The previous page's `next`. One that does not belong to this sort and period, or is not valid, is ignored. */
  cursor?: string | undefined;
  limit?: number;
  /** One community's posts (its page) or one author's (a profile), on top of the feed's own conditions; use with feed 'all'. */
  scope?: FeedScope;
};

export type FeedScope = { communityId: Uuid } | { authorId: Uuid };

/** A post found by a feed query: enough to order it, to cut the page and to continue after it. */
export type Key = {
  id: Uuid;
  /** published_at in microseconds since the epoch, exact. */
  pub: number;
  score: number;
  /** Hot's rank for a post inside its window; null for the rest. */
  rank: number | null;
};

/** Lemmy ranks the posts of the last week and gives every older one a rank of zero. */
const hotWindowMs = 7 * 24 * 3_600_000;
/** Popular is the All feed ranked by Hot, without the posts nobody has voted for. */
const popularMinimumScore = 2;

const msToInstant = (ms: number) => sql`('epoch'::timestamptz + ${ms}::bigint * interval '1 millisecond')`;
const microsToInstant = (micros: number) => sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`;

// The date index is `published_at desc nulls last`; Postgres only walks it for an ORDER BY that says the same
// (its default for desc is nulls first), or backwards for `asc nulls first`.
const newestFirst = sql`${posts.publishedAt} desc nulls last`;
const oldestFirst = sql`${posts.publishedAt} asc nulls first`;

const score = sql`(${posts.upvotes} - ${posts.downvotes})`;
const topFirst = sql`${score} desc nulls last, ${posts.id} desc nulls last`;
const publishedMicros = sql`(extract(epoch from ${posts.publishedAt}) * 1000000)::float8`;

/** `(published_at, id)` after or before a position, with a plain bound on published_at the date index can start from. */
const beyond = (direction: 'before' | 'after', micros: number, id: string) => {
  const at = microsToInstant(micros);
  return direction === 'before'
    ? sql`${posts.publishedAt} <= ${at} and (${posts.publishedAt}, ${posts.id}) < (${at}, ${id}::uuid)`
    : sql`${posts.publishedAt} >= ${at} and (${posts.publishedAt}, ${posts.id}) > (${at}, ${id}::uuid)`;
};

/**
 * Lemmy's hot rank: log10(max(1, score + 3)) / (hours since publishing + 2) ^ 1.8, for a post
 * published inside the window before `asOf` (the query keeps the others out).
 */
const hotRank = (asOf: number) =>
  sql`(log(greatest(1, ${score} + 3)::float8) / power(extract(epoch from (${msToInstant(asOf)} - ${posts.publishedAt}))::float8 / 3600 + 2, 1.8))`;

/** What every feed shows: live posts of open communities, published by the page's clock, past the predicates. Exported for the profile activity. */
export function visible(feed: FeedName, viewer: Viewer, asOf: number, scope?: FeedScope): SQL[] {
  const conditions: SQL[] = [
    isNull(posts.deletedAt),
    isNull(posts.removedAt),
    lte(posts.publishedAt, msToInstant(asOf)),
    sql`exists (
      select 1 from ${actors} as open_community
      where open_community.id = ${posts.communityId} and open_community.kind = 'Group' and open_community.deleted_at is null
        ${feed === 'local' ? sql`and open_community.local` : sql``}
    )`,
    sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${posts.communityId})`,
  ];
  if (viewer && feed === 'subscribed')
    conditions.push(
      sql`exists (
        select 1 from ${follows}
        where ${follows.followerId} = ${viewer.actorId} and ${follows.followeeId} = ${posts.communityId} and ${follows.state} = 'accepted'
      )`,
    );
  if (viewer && feed === 'moderating')
    conditions.push(
      sql`exists (
        select 1 from ${communityModerators}
        where ${communityModerators.moderatorId} = ${viewer.actorId} and ${communityModerators.communityId} = ${posts.communityId} and ${freshModerator}
      )`,
    );
  if (scope) conditions.push('communityId' in scope ? eq(posts.communityId, scope.communityId) : eq(posts.authorId, scope.authorId));
  if (feed === 'popular') conditions.push(sql`${score} >= ${popularMinimumScore}`);
  for (const predicate of feedPredicates) {
    const condition = predicate.where(viewer && { actorId: viewer.actorId });
    if (condition) conditions.push(condition);
  }
  return conditions;
}

type Reading = {
  q: Queryable;
  feed: FeedName;
  sort: Sort;
  period: Period;
  viewer: Viewer;
  asOf: number;
  cursor: Cursor | null;
  scope?: FeedScope | undefined;
};

const keyColumns = (rank: SQL | null) => ({
  id: posts.id,
  pub: sql<number>`${publishedMicros}`.mapWith(Number),
  score: sql<number>`${score}`.mapWith(Number),
  rank: sql<number | null>`${rank ?? sql`null::float8`}`.mapWith((value: unknown) => (value === null ? null : Number(value))),
});

/** New and Old: by date, then id. */
function byDate({ q, feed, viewer, asOf, cursor, scope }: Reading, direction: 'new' | 'old', want: number) {
  const conditions = visible(feed, viewer, asOf, scope);
  if (cursor) conditions.push(beyond(direction === 'new' ? 'before' : 'after', cursor.pub, cursor.id));
  return q
    .select(keyColumns(null))
    .from(posts)
    .where(and(...conditions))
    .orderBy(...(direction === 'new' ? [newestFirst, desc(posts.id)] : [oldestFirst, asc(posts.id)]))
    .limit(want);
}

/** Top: by score, then id, inside the period before `asOf`. */
function byScore({ q, feed, viewer, period, asOf, cursor, scope }: Reading, want: number) {
  const conditions = visible(feed, viewer, asOf, scope);
  if (period !== 'all') conditions.push(sql`${posts.publishedAt} > ${msToInstant(asOf - periodMs[period])}`);
  if (cursor && cursor.score !== undefined)
    conditions.push(sql`${score} <= ${cursor.score} and (${score}, ${posts.id}) < (${cursor.score}, ${cursor.id}::uuid)`);
  return q
    .select(keyColumns(null))
    .from(posts)
    .where(and(...conditions))
    .orderBy(topFirst)
    .limit(want);
}

/** Hot, first phase: the posts of the last week by rank, then date, then id. */
function byRank({ q, feed, viewer, asOf, cursor, scope }: Reading, want: number) {
  const conditions = visible(feed, viewer, asOf, scope);
  conditions.push(sql`${posts.publishedAt} > ${msToInstant(asOf - hotWindowMs)}`);
  const rank = hotRank(asOf);
  if (cursor && typeof cursor.rank === 'number')
    conditions.push(
      sql`(${rank}, ${posts.publishedAt}, ${posts.id}) < (${cursor.rank}::float8, ${microsToInstant(cursor.pub)}, ${cursor.id}::uuid)`,
    );
  return q
    .select(keyColumns(rank))
    .from(posts)
    .where(and(...conditions))
    .orderBy(sql`${rank} desc`, newestFirst, desc(posts.id))
    .limit(want);
}

/** Hot, second phase: posts older than the window have no rank, so they follow newest first. */
function afterWindow({ q, feed, viewer, asOf, cursor, scope }: Reading, want: number) {
  const conditions = visible(feed, viewer, asOf, scope);
  conditions.push(lte(posts.publishedAt, msToInstant(asOf - hotWindowMs)));
  if (cursor && cursor.rank === null) conditions.push(beyond('before', cursor.pub, cursor.id));
  return q
    .select(keyColumns(null))
    .from(posts)
    .where(and(...conditions))
    .orderBy(newestFirst, desc(posts.id))
    .limit(want);
}

/**
 * The key queries a page runs, in order, each for at most `want` rows: one for every sort but
 * Hot, which may need a second to continue past its week. Exported so the performance test can
 * EXPLAIN the very statements.
 */
export function keyQueries(reading: Reading): ((want: number) => { toSQL(): { sql: string; params: unknown[] } } & PromiseLike<Key[]>)[] {
  switch (reading.sort) {
    case 'new':
    case 'old':
      return [(want) => byDate(reading, reading.sort === 'new' ? 'new' : 'old', want)];
    case 'top':
      return [(want) => byScore(reading, want)];
    case 'hot':
      // A cursor already in the second phase has nothing left to rank.
      return reading.cursor?.rank === null
        ? [(want) => afterWindow(reading, want)]
        : [(want) => byRank(reading, want), (want) => afterWindow(reading, want)];
  }
}

async function readKeys(reading: Reading, want: number): Promise<Key[]> {
  const keys: Key[] = [];
  for (const query of keyQueries(reading)) {
    if (keys.length >= want) break;
    keys.push(...(await query(want - keys.length)));
  }
  return keys;
}

function cursorAfter(key: Key, sort: Sort, period: Period, asOf: number): Cursor {
  const position = { v: 1, sort, period, asOf, pub: key.pub, id: key.id } as const;
  if (sort === 'top') return { ...position, score: key.score };
  if (sort === 'hot') return { ...position, rank: key.rank };
  return position;
}

/**
 * One page of a feed for `viewer` (null when signed out). Subscribed and Moderating need a
 * viewer and are empty without one. `next` is null on the last page; a page boundary never
 * repeats or skips a post while the data is unchanged, and a post published after the first
 * page, or a vote after it for the sorts that read the score, cannot reorder the pages that
 * follow the ones already read, except for the score of a post still ahead of the cursor.
 */
export async function readFeed(request: FeedRequest, viewer: Viewer, q: Queryable = db()): Promise<Page<PostView>> {
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? defaultPageSize), 1), maxPageSize);
  const period = request.sort === 'top' ? (request.period ?? defaultPeriod) : 'all';
  const decoded = decodeCursor(request.cursor);
  const cursor = decoded && decoded.sort === request.sort && decoded.period === period ? decoded : null;
  if (!viewer && (request.feed === 'subscribed' || request.feed === 'moderating')) return { items: [], next: null };

  const asOf = cursor?.asOf ?? Date.now();
  const keys = await readKeys({ q, feed: request.feed, sort: request.sort, period, viewer, asOf, cursor, scope: request.scope }, limit + 1);
  const page = keys.slice(0, limit);
  const last = page.at(-1);
  const next = keys.length > limit && last ? encodeCursor(cursorAfter(last, request.sort, period, asOf)) : null;
  if (page.length === 0) return { items: [], next: null };

  const rows = await q
    .select()
    .from(posts)
    .where(
      inArray(
        posts.id,
        page.map(({ id }) => id),
      ),
    );
  const byId = new Map<string, PostRow>(rows.map((row) => [row.id, row]));
  const ordered = page.flatMap(({ id }) => byId.get(id) ?? []);
  return { items: await postViews(ordered, viewer, q), next };
}
