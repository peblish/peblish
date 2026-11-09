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

/**
 * Where the previous page ended, plus the clock it was ranked with. `asOf` (milliseconds) is
 * fixed by the first page: a post published after it never joins a later page, and the Top
 * window and Hot ranks are computed against the same time on every page. `pub` is the last
 * row's published_at in microseconds, exact for what Postgres stores, and `id` breaks ties.
 *
 * - Top also carries the last row's `score`.
 * - Hot carries its `rank`; null once the walk has left the week Hot ranks and continues by
 *   date (Lemmy gives older posts a rank of zero, so they follow the ranked ones newest first).
 */
export const Cursor = type({
  v: '1',
  sort: Sort,
  period: Period,
  asOf: 'number.integer > 0',
  pub: 'number.integer > 0',
  id: Uuid,
  'score?': 'number.integer',
  'rank?': 'number | null',
});
export type Cursor = typeof Cursor.infer;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** The cursor a page handed out, or null for anything else (a stale or edited link starts again at the first page). */
export function decodeCursor(text: string | undefined): Cursor | null {
  if (!text || text.length > 400) return null;
  try {
    const parsed = Cursor(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
    return parsed instanceof type.errors ? null : parsed;
  } catch {
    return null;
  }
}
