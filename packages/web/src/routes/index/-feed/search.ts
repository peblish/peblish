import { Period, Sort, defaultPeriod, defaultSort } from '@peblish/core/feeds/input';
import type { SearchSchemaInput } from '@tanstack/react-router';

// A feed's address: /all?sort=top&period=week&cursor=… . Every part is optional, and a part that
// is not valid is dropped, so a stale or hand-edited link still opens a feed. The router keeps
// only what is in the address (it redirects to the cleaned form if the two differ), so the
// defaults are applied after parsing, never written into the URL.

export type FeedSearch = { sort?: Sort | undefined; period?: Period | undefined; cursor?: string | undefined };
/** A feed address with the defaults filled in. */
export type FeedPosition = { sort: Sort; period: Period; cursor?: string | undefined };

/**
 * The route's `validateSearch`. Every key is optional on the way in, so a plain link to a feed
 * needs no search (SearchSchemaInput tells the router's Link to type the input, not the result).
 * It always names all three keys: the router lays the result over the raw address, so a key that
 * is not valid must come back as undefined to be dropped.
 */
export function parseFeedSearch(raw: { sort?: unknown; period?: unknown; cursor?: unknown } & SearchSchemaInput): FeedSearch {
  const sort = Sort(raw.sort);
  const period = Period(raw.period);
  return {
    sort: typeof sort === 'string' ? sort : undefined,
    period: typeof period === 'string' ? period : undefined,
    cursor: typeof raw.cursor === 'string' && raw.cursor.length > 0 && raw.cursor.length <= 400 ? raw.cursor : undefined,
  };
}

export const resolveFeedSearch = ({ sort, period, cursor }: FeedSearch): FeedPosition => ({
  sort: sort ?? defaultSort,
  period: period ?? defaultPeriod,
  cursor,
});

/** The address of `path` with a sort, a Top period and a page; what is default is left out. */
export function feedHref(path: string, { sort, period, cursor }: FeedPosition): string {
  const params = new URLSearchParams();
  if (sort !== defaultSort) params.set('sort', sort);
  if (sort === 'top' && period !== defaultPeriod) params.set('period', period);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
