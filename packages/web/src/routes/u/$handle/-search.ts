import { profileSorts, profileTabs, type ProfileSort, type ProfileTab } from '@peblish/core/profiles/input';
import { type } from 'arktype';

// A profile's address: /u/<handle>?tab=posts&sort=top&after=… . Every key is optional and one
// that is not valid is dropped, so a stale or hand-edited link still opens the page. The
// defaults are applied after parsing and never written into the address.

const Tab = type.enumerated(...profileTabs);
const Sort = type.enumerated(...profileSorts);

export type ProfileSearch = {
  tab?: ProfileTab | undefined;
  sort?: ProfileSort | undefined;
  after?: string | undefined;
  /** The edit page: `saved=true` after a save without scripts, `error=<reason>` after a refusal. */
  saved?: true | undefined;
  error?: string | undefined;
};

export function parseProfileSearch(raw: Record<string, unknown>): ProfileSearch {
  const tab = Tab(raw.tab);
  const sort = Sort(raw.sort);
  const text = (value: unknown, max: number) => {
    const s = typeof value === 'number' ? String(value) : value;
    return typeof s === 'string' && s.length > 0 && s.length <= max ? s : undefined;
  };
  return {
    tab: typeof tab === 'string' ? tab : undefined,
    sort: typeof sort === 'string' ? sort : undefined,
    after: text(raw.after, 400),
    saved: raw.saved === true || raw.saved === 'true' || raw.saved === 1 || raw.saved === '1' ? true : undefined,
    error: text(raw.error, 40),
  };
}

export const resolveProfileSearch = ({
  tab,
  sort,
  after,
}: ProfileSearch): { tab: ProfileTab; sort: ProfileSort; after?: string | undefined } => ({
  tab: tab ?? 'overview',
  sort: sort ?? 'new',
  after,
});

/** The address of a profile with a tab, a sort and a page; what is default is left out. */
export function profileHref(
  path: string,
  { tab, sort, after }: { tab: ProfileTab; sort: ProfileSort; after?: string | undefined },
): string {
  const params = new URLSearchParams();
  if (tab !== 'overview') params.set('tab', tab);
  if (sort !== 'new') params.set('sort', sort);
  if (after) params.set('after', after);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
