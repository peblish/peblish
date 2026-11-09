import { randomUUID } from 'node:crypto';
import { PUBLIC } from '../mapping/vocabulary.ts';

// Test support for the inbound pipeline (never imported by product code).

export { PUBLIC };

export const hosts = {
  spike: 'https://fed-b.test/ap/c.spike',
  lab: 'https://lemmy.test/c/lab',
  lemmyuser: 'https://lemmy.test/u/lemmyuser',
  lemmyadmin: 'https://lemmy.test/u/lemmyadmin',
  pfuser: 'https://piefed.test/u/pfuser',
  mallory: 'https://rogue.test/u/mallory',
  fake: 'https://rogue.test/c/fake',
  t1: 'https://lemmy.test/post/1',
  t2: 'https://lemmy.test/post/2',
} as const;

/** A fresh activity id on `origin`. */
export const activityId = (origin: string, type: string) => `${origin}/activities/${type.toLowerCase()}/${randomUUID()}`;

export const addressedToCommunity = (community: string) => ({ to: [PUBLIC], cc: [community], audience: community });
