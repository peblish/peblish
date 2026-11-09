import { type } from 'arktype';

// What the community directory is asked: pure (ArkType only), so the web route validates its
// address with the same names and defaults. Every part is optional and a part that is not valid
// is dropped, so a stale or hand-edited link still opens the list.

export const scopes = ['all', 'local'] as const;
/** Most subscribers, most active, newest, A to Z. */
export const directorySorts = ['subscribers', 'active', 'newest', 'name'] as const;
/** Hide NSFW communities, show them with the rest, or show only them. */
export const nsfwModes = ['hide', 'show', 'only'] as const;

export const Scope = type.enumerated(...scopes);
export const DirectorySort = type.enumerated(...directorySorts);
export const NsfwMode = type.enumerated(...nsfwModes);
export type Scope = typeof Scope.infer;
export type DirectorySort = typeof DirectorySort.infer;
export type NsfwMode = typeof NsfwMode.infer;

export const pageSize = 25;
/** Offset paging stops here: 20 pages of 25 is 500 communities. */
export const maxPage = 20;
export const maxSearchLength = 100;

export type DirectoryQuery = { scope: Scope; sort: DirectorySort; nsfw: NsfwMode; q: string; page: number };
/** An address's parts as parsed: what was valid, undefined for the rest. */
export type DirectorySearch = { [K in keyof DirectoryQuery]?: DirectoryQuery[K] | undefined };

export const defaultQuery: DirectoryQuery = { scope: 'all', sort: 'subscribers', nsfw: 'hide', q: '', page: 1 };

/**
 * The route's `validateSearch`. It always names every key: the router lays the result over the
 * raw address, so a key that is not valid must come back as undefined to be dropped.
 */
export function parseDirectorySearch(raw: Record<string, unknown>): DirectorySearch {
  const scope = Scope(raw.scope);
  const sort = DirectorySort(raw.sort);
  const nsfw = NsfwMode(raw.nsfw);
  // The router parses ?q=2024 into a number.
  const q = typeof raw.q === 'string' || typeof raw.q === 'number' ? String(raw.q).trim().slice(0, maxSearchLength) : '';
  const page = Number(raw.page);
  return {
    scope: typeof scope === 'string' ? scope : undefined,
    sort: typeof sort === 'string' ? sort : undefined,
    nsfw: typeof nsfw === 'string' ? nsfw : undefined,
    q: q === '' ? undefined : q,
    page: Number.isInteger(page) && page >= 2 && page <= maxPage ? page : undefined,
  };
}

export const resolveDirectoryQuery = (search: DirectorySearch): DirectoryQuery => ({
  scope: search.scope ?? defaultQuery.scope,
  sort: search.sort ?? defaultQuery.sort,
  nsfw: search.nsfw ?? defaultQuery.nsfw,
  q: search.q ?? defaultQuery.q,
  page: search.page ?? defaultQuery.page,
});

/** The address of the directory with `query`; what is default is left out. */
export function directoryHref(path: string, query: Partial<DirectoryQuery>): string {
  const params = new URLSearchParams();
  if (query.scope && query.scope !== defaultQuery.scope) params.set('scope', query.scope);
  if (query.sort && query.sort !== defaultQuery.sort) params.set('sort', query.sort);
  if (query.nsfw && query.nsfw !== defaultQuery.nsfw) params.set('nsfw', query.nsfw);
  if (query.q) params.set('q', query.q);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * Whose NSFW setting applies: a viewer who has not declared 16+ (or is signed out) gets Hide
 * whatever was asked for.
 */
export const effectiveNsfw = (query: Pick<DirectoryQuery, 'nsfw'>, viewer: { declared: boolean } | null): NsfwMode =>
  viewer?.declared ? query.nsfw : 'hide';
