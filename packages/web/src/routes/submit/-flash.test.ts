import { expect, test } from 'vitest';
import { keepFlash, readFlash } from './-flash.ts';
import type { Kept } from './-types.ts';

const kept = (over: Partial<Kept> = {}): Kept => ({
  community: null,
  type: 'text',
  title: 'Ünï 日本語 "quotes" & 100%?',
  url: '',
  body: '# heading\n\n+ plus / slash',
  alt: '',
  nsfw: false,
  ...over,
});

test('what was typed comes back to the person it belongs to, as it was, for a while', () => {
  const now = Date.now();
  const id = keepFlash('ann', kept(), now);
  expect(readFlash(id, 'ann', now + 1)).toEqual(kept());
  // Reading does not use it up: a reload of the refused page shows the same words.
  expect(readFlash(id, 'ann', now + 2)).toEqual(kept());
  expect(readFlash(id, 'bob', now + 1)).toBeNull();
  expect(readFlash('nothing', 'ann')).toBeNull();
  expect(readFlash(undefined, 'ann')).toBeNull();
  expect(readFlash(id, 'ann', now + 11 * 60_000)).toBeNull();
});

test('a body past twice the post limit is cut, a long one under it comes back whole', () => {
  const now = Date.now();
  const long = 'x'.repeat(50_001);
  expect(readFlash(keepFlash('ann', kept({ body: long }), now), 'ann', now)?.body).toBe(long);
  expect(readFlash(keepFlash('ann', kept({ body: 'y'.repeat(200_000) }), now), 'ann', now)?.body).toHaveLength(100_000);
});

test('a person keeps two refusals; a third replaces the oldest, and nobody else is touched', () => {
  const now = Date.now();
  const other = keepFlash('bob', kept({ title: 'Bob' }), now);
  const [first, second, third] = ['one', 'two', 'three'].map((title) => keepFlash('ann', kept({ title }), now));
  expect(readFlash(first, 'ann', now)).toBeNull();
  expect(readFlash(second, 'ann', now)?.title).toBe('two');
  expect(readFlash(third, 'ann', now)?.title).toBe('three');
  expect(readFlash(other, 'bob', now)?.title).toBe('Bob');
});

test('the whole is bounded: past 100 entries the oldest go first', () => {
  const now = Date.now();
  const ids = Array.from({ length: 101 }, (_, index) => keepFlash(`person-${index}`, kept({ title: `${index}` }), now));
  expect(readFlash(ids[0], 'person-0', now)).toBeNull();
  expect(readFlash(ids[1], 'person-1', now)?.title).toBe('1');
  expect(readFlash(ids[100], 'person-100', now)?.title).toBe('100');
});
