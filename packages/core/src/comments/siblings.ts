import type { Uuid } from '@peblish/schema/ids';
import { and, asc, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { comments } from '../db/tables/content.ts';
import type { ThreadCursor } from './cursor.ts';
import type { ThreadSort } from './sort.ts';

// Reading siblings in a sort's order, in SQL, so a page of them is chosen in that order before
// the limit and a thread's cost does not grow with the thread: a page of one set of siblings
// (the post's top-level comments, or the replies under one comment) by keyset, and the first
// few replies under each of a list of comments. Hot ranks against the clock the first page
// fixed (`asOf`), so every page of a walk is ordered the same.

/** A comment found by a thread query, without its text (a page shows a fraction of them). */
export type Row = {
  id: Uuid;
  apId: string;
  authorId: Uuid;
  parentId: Uuid | null;
  path: string;
  upvotes: number;
  downvotes: number;
  publishedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  removedAt: Date | null;
  /** Every comment under this one, however deep (a tombstone counts): comments.child_count. */
  childCount: number;
};

/** A row of a page of siblings, with what the next page continues from. */
export type Keyed = Row & { pub: number; score: number; rank: number };

/** The columns of a Row. */
export const rowColumns = {
  id: comments.id,
  apId: comments.apId,
  authorId: comments.authorId,
  parentId: comments.parentId,
  path: comments.path,
  upvotes: comments.upvotes,
  downvotes: comments.downvotes,
  publishedAt: comments.publishedAt,
  editedAt: comments.editedAt,
  deletedAt: comments.deletedAt,
  removedAt: comments.removedAt,
  childCount: comments.childCount,
};

const score = sql`(${comments.upvotes} - ${comments.downvotes})`;
const instant = (ms: number) => sql`('epoch'::timestamptz + ${ms}::bigint * interval '1 millisecond')`;
const microsToInstant = (micros: number) => sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`;

/**
 * Lemmy's hot rank at `asOf`: log10(max(1, score + 3)) / (hours since publishing + 2) ^ 1.8.
 * A comment published after `asOf` ranks as a brand new one.
 */
const hotRank = (asOf: number) =>
  sql`(log(greatest(1, ${score} + 3)::float8) / power(greatest(0, extract(epoch from (${instant(asOf)} - ${comments.publishedAt}))::float8 / 3600) + 2, 1.8))`;

/** The sort as an ORDER BY; equal keys fall back to the date and then the id, so there is one order. */
function orderBy(sort: ThreadSort, asOf: number): SQL[] {
  switch (sort) {
    case 'hot':
      return [sql`${hotRank(asOf)} desc`, desc(comments.publishedAt), desc(comments.id)];
    case 'top':
      return [sql`${score} desc`, desc(comments.publishedAt), desc(comments.id)];
    case 'new':
      return [desc(comments.publishedAt), desc(comments.id)];
    case 'old':
      return [asc(comments.publishedAt), asc(comments.id)];
  }
}

/** The comments after the cursor in the sort's order: a row-value comparison on the same keys. */
function beyond(cursor: ThreadCursor, asOf: number): SQL {
  const published = microsToInstant(cursor.pub);
  switch (cursor.sort) {
    case 'hot':
      return sql`(${hotRank(asOf)}, ${comments.publishedAt}, ${comments.id}) < (${cursor.rank ?? 0}::float8, ${published}, ${cursor.id}::uuid)`;
    case 'top':
      return sql`(${score}, ${comments.publishedAt}, ${comments.id}) < (${cursor.score ?? 0}, ${published}, ${cursor.id}::uuid)`;
    case 'new':
      return sql`(${comments.publishedAt}, ${comments.id}) < (${published}, ${cursor.id}::uuid)`;
    case 'old':
      return sql`(${comments.publishedAt}, ${comments.id}) > (${published}, ${cursor.id}::uuid)`;
  }
}

/**
 * Up to `want` of the comments that reply to `parentId` (the post's top-level comments when
 * null), in the sort's order, after `cursor` when there is one.
 */
export function siblingsPage(
  q: Queryable,
  set: { postId: Uuid; parentId: Uuid | null },
  options: { sort: ThreadSort; asOf: number; cursor: ThreadCursor | null; want: number },
): Promise<Keyed[]> {
  const { sort, asOf, cursor, want } = options;
  return q
    .select({
      ...rowColumns,
      pub: sql<number>`(extract(epoch from ${comments.publishedAt}) * 1000000)::float8`.mapWith(Number),
      score: sql<number>`${score}`.mapWith(Number),
      rank: sql<number>`${sort === 'hot' ? hotRank(asOf) : sql`0::float8`}`.mapWith(Number),
    })
    .from(comments)
    .where(
      and(
        eq(comments.postId, set.postId),
        set.parentId ? eq(comments.parentId, set.parentId) : isNull(comments.parentId),
        cursor ? beyond(cursor, asOf) : undefined,
      ),
    )
    .orderBy(...orderBy(sort, asOf))
    .limit(want);
}

/**
 * The first `perParent` replies under each of `parentIds`, in the sort's order, grouped by
 * parent in the order the parents are given, at most `limit` rows in all. So the parents that
 * come first in the thread get their replies first when the page is nearly full.
 */
export async function repliesUnder(
  q: Queryable,
  parentIds: readonly Uuid[],
  options: { sort: ThreadSort; asOf: number; perParent: number; limit: number },
): Promise<Row[]> {
  const { sort, asOf, perParent, limit } = options;
  if (parentIds.length === 0 || limit <= 0) return [];
  const ranked = q
    .select({
      ...rowColumns,
      place: sql<number>`row_number() over (partition by ${comments.parentId} order by ${sql.join(orderBy(sort, asOf), sql`, `)})`
        .mapWith(Number)
        .as('place'),
    })
    .from(comments)
    .where(inArray(comments.parentId, [...parentIds]))
    .as('ranked');
  const given = sql.join(
    parentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const found = await q
    .select()
    .from(ranked)
    .where(lte(ranked.place, perParent))
    .orderBy(sql`array_position(array[${given}], ${ranked.parentId})`, ranked.place)
    .limit(limit);
  return found.map(({ place: _place, ...row }) => row);
}
