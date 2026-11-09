import { expect, test } from 'vitest';
import { announceShape, microblogSoftware, threadiverseSoftware } from './software.ts';

test('the two software lists are disjoint, and each name gets its shape', () => {
  expect(microblogSoftware.filter((name) => (threadiverseSoftware as readonly string[]).includes(name))).toEqual([]);
  expect(threadiverseSoftware.map((name) => announceShape(name))).toEqual(threadiverseSoftware.map(() => 'create'));
  expect(microblogSoftware.map((name) => announceShape(name))).toEqual(microblogSoftware.map(() => 'page'));
});

test('software we have not read, or do not know, gets the FEP-1b12 shape; names are not case-sensitive', () => {
  expect([announceShape(null), announceShape('some-new-thing'), announceShape('Mastodon'), announceShape('LEMMY')]).toEqual([
    'create',
    'create',
    'page',
    'create',
  ]);
});
