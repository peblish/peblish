import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { seedPost } from '../../packages/core/src/testing/seed-az.ts';
import { seedActor } from '../../packages/core/src/testing/seed.ts';

// A page of local posts, so the signed-out feed is well over a screen long even on a fresh lane database
// (e2e/shell/scroll-at-hydration.spec.ts scrolls it in a 300px window). They are a year old: they sit under
// every recent post in New and Hot, so they push no other spec's posts off a first page. Every run uses fresh
// names. `node e2e/shell/seed-scroll.ts`.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const here = await localInstance(db());
  const local = { ...here, domain: new URL(here.origin).host, local: true };
  const community = await seedActor(local, 'Group', `scroll_${suffix}`);
  const author = await seedActor(local, 'Person', `scroller_${suffix}`);
  const yearAgo = Date.now() - 365 * 24 * 60 * 60_000;
  for (let i = 0; i < 20; i++)
    await seedPost(local, community, author, { title: `Scroll filler ${suffix} ${i + 1}`, publishedAt: new Date(yearAgo - i * 60_000) });
} finally {
  await closePools();
}
