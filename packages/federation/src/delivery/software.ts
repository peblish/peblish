// Which Announce shape a follower's software wants. A community announces a new post to each
// follower inbox in exactly one of two shapes (slice 3):
//
// - 'create': Announce(Create(Page)), FEP-1b12. Lemmy, PieFed and Mbin read it. Lemmy rejects
//   Announce(Page) outright and PieFed ignores it.
// - 'page': Announce(Page). Mastodon drops Announce(Create(Page)) and fetches the Page by id
//   from this shape instead, the second copy Lemmy sends every follower.
//
// Never both to one inbox. The software comes from the follower instance's NodeInfo
// (instances.software); an instance we have not read it from gets the FEP-1b12 shape.

/** Threadiverse software: FEP-1b12. Listed for the record and the test; the default is 'create' anyway. */
export const threadiverseSoftware = ['lemmy', 'piefed', 'mbin', 'kbin', 'sublinks', 'lotide', 'peblish'] as const;

/** Mastodon and the software that reads like it (NodeInfo names, lowercase): Announce(Page). */
export const microblogSoftware = [
  'mastodon',
  'hometown',
  'glitch',
  'pleroma',
  'akkoma',
  'misskey',
  'calckey',
  'firefish',
  'iceshrimp',
  'sharkey',
  'foundkey',
  'gotosocial',
  'snac',
  'takahe',
] as const;

export type AnnounceShape = 'create' | 'page';

const microblog: ReadonlySet<string> = new Set(microblogSoftware);

/** The shape for a follower instance running `software` (NodeInfo's name; null when unknown). */
export function announceShape(software: string | null): AnnounceShape {
  return software !== null && microblog.has(software.toLowerCase()) ? 'page' : 'create';
}
