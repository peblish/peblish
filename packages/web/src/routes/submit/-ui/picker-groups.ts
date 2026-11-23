import type { PickerCommunity } from '../-types.ts';

// The one place Create post's grouped picker reads the composer loader's list (-load.ts), so the loader can change
// under it (a bound with a `truncated` flag, the viewer's follows first) and only this function follows.

/** How many local communities the loader lists at most (listLocalCommunities' default limit). */
export const localCap = 200;

export interface PickerGroups {
  joined: PickerCommunity[];
  others: PickerCommunity[];
  /** The loader stopped at its cap, so some communities are not offered here: the field says so and offers Browse. */
  truncated: boolean;
}

/**
 * Joined first (communities in `joinedIds`, the sidebar's list from the root loader, and every remote one, which the
 * loader lists only when the viewer follows it), then the rest, each by name as the loader orders them. The loader
 * does not say whether it cut its list short; a full local list is taken to mean it did.
 */
export function pickerGroups(communities: readonly PickerCommunity[], joinedIds: ReadonlySet<string>): PickerGroups {
  const joined = communities.filter((community) => !community.local || joinedIds.has(community.id));
  const others = communities.filter((community) => community.local && !joinedIds.has(community.id));
  const truncated = communities.filter((community) => community.local).length >= localCap;
  return { joined, others, truncated };
}
