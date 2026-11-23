import { Period, Sort, defaultPageSize, defaultPeriod, defaultSort, maxDepth } from '@peblish/core/feeds/input';
import type { SearchSchemaInput } from '@tanstack/react-router';

// A feed's address: /all?sort=top&period=week&cursor=…&n=80 . Every part is optional, and a part that
// is not valid is dropped, so a stale or hand-edited link still opens a feed. `n` is how many rows the
// list holds: the list writes it into its own history entry as it loads more, and the loader reads that
// many again on any load of the entry (Back, Forward, a reload), so the place is in the address. The router keeps
// only what is in the address (it redirects to the cleaned form if the two differ), so the
// defaults are applied after parsing, never written into the URL.

export type FeedSearch = { sort?: Sort | undefined; period?: Period | undefined; cursor?: string | undefined; n?: number | undefined };
/** A feed address with the defaults filled in, as the loader's deps (`n` is read apart, so growing it loads nothing). */
export type FeedPosition = { sort: Sort; period: Period; cursor?: string | undefined };

/** `n` as the address has it: whole batches beyond the first, at most `maxDepth`; anything else is one batch (undefined). */
export function depth(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value <= defaultPageSize || value % defaultPageSize !== 0) return undefined;
  return Math.min(value, maxDepth);
}

/**
 * The route's `validateSearch`. Every key is optional on the way in, so a plain link to a feed
 * needs no search (SearchSchemaInput tells the router's Link to type the input, not the result).
 * It always names every key: the router lays the result over the raw address, so a key that
 * is not valid must come back as undefined to be dropped.
 */
export function parseFeedSearch(raw: { sort?: unknown; period?: unknown; cursor?: unknown; n?: unknown } & SearchSchemaInput): FeedSearch {
  const sort = Sort(raw.sort);
  const period = Period(raw.period);
  return {
    sort: typeof sort === 'string' ? sort : undefined,
    period: typeof period === 'string' ? period : undefined,
    cursor: typeof raw.cursor === 'string' && raw.cursor.length > 0 && raw.cursor.length <= 400 ? raw.cursor : undefined,
    n: depth(raw.n),
  };
}

export const resolveFeedSearch = ({ sort, period, cursor }: FeedSearch): FeedPosition => ({
  sort: sort ?? defaultSort,
  period: period ?? defaultPeriod,
  cursor,
});

/** The address of `path` with a sort, a Top period, a page and how many rows; what is default is left out. */
export function feedHref(path: string, { sort, period, cursor, n }: FeedPosition & { n?: number | undefined }): string {
  const params = new URLSearchParams();
  if (sort !== defaultSort) params.set('sort', sort);
  if (sort === 'top' && period !== defaultPeriod) params.set('period', period);
  if (cursor) params.set('cursor', cursor);
  if (n && n > defaultPageSize) params.set('n', String(Math.min(n, maxDepth)));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
