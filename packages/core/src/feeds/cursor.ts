import { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { Period, Sort } from './input.ts';

/** How long a Top window reaches back, in milliseconds; all time has none. */
export const periodMs: Record<Exclude<Period, 'all'>, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '12h': 12 * 3_600_000,
  day: 24 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  month: 30 * 24 * 3_600_000,
  year: 365 * 24 * 3_600_000,
};

/** The server's own clock wrote `asOf`; this much ahead of the reader's is clock skew between processes, more is forged. */
const clockSkewMs = 60_000;

/**
 * Where the previous page ended, plus the clock it was ranked with. `asOf` (milliseconds) is
 * fixed by the first page: a post published after it never joins a later page, and the Top
 * window and Hot ranks are computed against the same time on every page. `pub` is the last
 * row's published_at in microseconds, exact for what Postgres stores, and `id` breaks ties.
 *
 * - Top also carries the last row's `score`.
 * - Hot carries its `rank`; null once the walk has left the week Hot ranks and continues by
 *   date (Lemmy gives older posts a rank of zero, so they follow the ranked ones newest first).
 *
 * The cursor is not signed, so every number is bounded to what the queries can take as a
 * parameter, because a value Postgres cannot cast is an error page, not an empty one:
 * - `asOf` and `pub` are positive safe integers (`decodeCursor` also keeps them inside the clock).
 * - `score` is an upvotes-minus-downvotes difference, so it fits the int4 columns' range.
 * - `rank` is log10(score + 3) / (hours + 2) ^ 1.8, under 3 for any int4 score; 10 is far past it.
 */
export const Cursor = type({
  v: '1',
  sort: Sort,
  period: Period,
  asOf: '0 < number.integer <= 9007199254740991',
  pub: '0 < number.integer <= 9007199254740991',
  id: Uuid,
  'score?': '-2147483648 <= number.integer <= 2147483647',
  'rank?': '0 <= number <= 10 | null',
});
export type Cursor = typeof Cursor.infer;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** What the shape cannot say: the clock, and the fields the sort continues from. */
function continuable({ sort, asOf, pub, score, rank }: Cursor, now: number): boolean {
  // The page's clock is never ahead of this one, and it only ranked posts published before it.
  if (asOf > now + clockSkewMs || pub > asOf * 1000) return false;
  if (sort === 'top') return score !== undefined;
  if (sort === 'hot') return rank !== undefined;
  return true;
}

/**
 * The cursor a page handed out, or null for anything else (a stale, edited or forged link
 * starts again at the first page): what comes back is safe to give the queries as it is.
 */
export function decodeCursor(text: string | undefined, now = Date.now()): Cursor | null {
  if (!text || text.length > 400) return null;
  try {
    const parsed = Cursor(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
    return parsed instanceof type.errors || !continuable(parsed, now) ? null : parsed;
  } catch {
    return null;
  }
}
