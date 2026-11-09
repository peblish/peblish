import type { BlockKind } from '@peblish/core/blocks/actions';
import { type } from 'arktype';

// The three lists of /settings/blocks and how they are named in the address (`?tab=`) and in a
// form (`kind`). Pure, so the page, the loader and the POST handler agree.

export const blockTabs = ['people', 'communities', 'instances'] as const;
export type BlockTab = (typeof blockTabs)[number];

export const kindOfTab: Record<BlockTab, BlockKind> = { people: 'person', communities: 'community', instances: 'instance' };
export const tabOfKind: Record<BlockKind, BlockTab> = { person: 'people', community: 'communities', instance: 'instances' };
export const blocksPath = '/settings/blocks';

/** The address of the blocks page on `tab`, with what the page reads from the query. */
export function blocksHref(tab: BlockTab, extra: { just?: string; error?: string; q?: string } = {}): string {
  const params = new URLSearchParams({ tab });
  for (const [name, value] of Object.entries(extra)) if (value) params.set(name, value);
  return `${blocksPath}?${params}`;
}

const Tab = type.enumerated(...blockTabs);

export type BlocksSearch = { tab?: BlockTab | undefined; just?: string | undefined; error?: string | undefined; q?: string | undefined };

/**
 * The route's `validateSearch`: every key optional, and one that is not valid is dropped, so a
 * stale or hand-edited link still opens the page. TanStack parses `?q=123` as a number, so text
 * is taken either way.
 */
export function parseBlocksSearch(raw: Record<string, unknown>): BlocksSearch {
  const tab = Tab(raw.tab);
  const text = (value: unknown, max: number) => {
    const s = typeof value === 'number' ? String(value) : value;
    return typeof s === 'string' && s.length > 0 && s.length <= max ? s : undefined;
  };
  const just = text(raw.just, 36);
  return {
    tab: typeof tab === 'string' ? tab : undefined,
    just: just && /^[0-9a-f-]{36}$/.test(just) ? just : undefined,
    error: text(raw.error, 40),
    q: text(raw.q, 300),
  };
}
