import type { PickerCommunity } from '../-types.ts';

// The one place Create post's grouped picker reads the composer loader's list (-load.ts), so the loader can change
// under it (a bound with a `truncated` flag, the viewer's follows first) and only this function follows.

export interface PickerGroups {
  joined: PickerCommunity[];
  others: PickerCommunity[];
  /** The loader stopped at its cap, so some communities are not offered here: the field says so and offers Browse. */
  truncated: boolean;
}

/**
 * Joined first (communities in `joinedIds`, the sidebar's list from the root loader, local or remote), then the rest,
 * each by name as the loader orders them. The rest can hold a remote community: one the loader looked up because the
 * form starts in it, which the viewer does not follow. `truncated` is the loader's own (`pickerTruncated`).
 */
export function pickerGroups(communities: readonly PickerCommunity[], joinedIds: ReadonlySet<string>, truncated: boolean): PickerGroups {
  const joined = communities.filter((community) => joinedIds.has(community.id));
  const others = communities.filter((community) => !joinedIds.has(community.id));
  return { joined, others, truncated };
}
