import { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { ThreadSortParam, type ThreadSort } from './sort.ts';

/** The year 2100 in milliseconds: nothing a cursor names is later, and the SQL arithmetic on it cannot overflow. */
const lastMs = 4_102_444_800_000;
/** An integer column's largest value; a score is a difference of two. */
const intMax = 2_147_483_647;

/**
 * Where the previous page of one set of siblings ended, plus the clock it was ranked with.
 * `asOf` (milliseconds) is fixed by the first page, so Hot ranks every page against the same
 * time. `pub` is the last comment's published_at in microseconds, exact for what Postgres
 * stores, and `id` breaks ties. Top also carries the last comment's `score`, Hot its `rank`.
 * `parent` is the comment whose replies are paged, null for the post's top-level comments.
 */
export const ThreadCursor = type({
  v: '1',
  sort: ThreadSortParam,
  parent: Uuid.or('null'),
  asOf: `1 <= number.integer <= ${lastMs}`,
  pub: `1 <= number.integer <= ${lastMs * 1000}`,
  id: Uuid,
  'score?': `${-intMax - 1} <= number.integer <= ${intMax}`,
  'rank?': 'number',
});
export type ThreadCursor = typeof ThreadCursor.infer;

export const encodeCursor = (cursor: ThreadCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

/**
 * The cursor a page handed out for this sort and this set of siblings, or null for anything
 * else (a stale, edited or foreign link starts again at the first page, never an error).
 */
export function decodeCursor(text: string | null | undefined, sort: ThreadSort, parent: string | null): ThreadCursor | null {
  if (!text || text.length > 400) return null;
  try {
    const cursor = ThreadCursor(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
    if (cursor instanceof type.errors || cursor.sort !== sort || cursor.parent !== parent) return null;
    // The key the sort orders by must be there.
    if ((sort === 'hot' && cursor.rank === undefined) || (sort === 'top' && cursor.score === undefined)) return null;
    return cursor;
  } catch {
    return null;
  }
}
