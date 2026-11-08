import { loadFixtureSet, type LoadedFixtureSet } from '../fixtures/load.ts';

// Lane FIT's seeds: the lab-live fixture set (packages/core/src/fixtures/sets/lab-live.json)
// and the ap_ids tests reach for most. Rows are found with `lab.id(apId)`.

export const labLive = {
  /** The spike's community; local when the set is seeded with { local: true }. */
  spikeCommunity: 'https://feddit.lab.test/ap/c.spike',
  spikeAuthor: 'https://feddit.lab.test/ap/u.t1108022622',
  lemmyCommunity: 'https://lemmy.lab.test/c/lab',
  lemmyUser: 'https://lemmy.lab.test/u/lemmyuser',
  lemmyPost: 'https://lemmy.lab.test/post/10',
  piefedCommunity: 'https://piefed.lab.test/c/pflab',
  piefedUser: 'https://piefed.lab.test/u/pfuser',
} as const;

/** Seeds lab-live, all remote by default; `local: true` makes the spike's instance (feddit.lab.test) local. */
export function seedLabLive({ local = false } = {}): Promise<LoadedFixtureSet> {
  return loadFixtureSet('lab-live', local ? { localDomain: 'feddit.lab.test' } : {});
}
