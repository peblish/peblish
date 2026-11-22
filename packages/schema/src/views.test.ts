import { expect, test } from 'vitest';
import { SeriesPart } from './views.ts';

test('a hidden or removed series part is a numbered gap with no other field', () => {
  expect(SeriesPart.allows({ ordinal: 2, state: 'hidden' })).toBe(true);
  expect(SeriesPart.allows({ ordinal: 3, state: 'removed' })).toBe(true);
  for (const leak of [{ id: '01a1fef4-fa77-7167-a41b-9d1bc70b7ca9' }, { title: 'Part 2' }, { post: null }]) {
    expect(SeriesPart.allows({ ordinal: 2, state: 'hidden', ...leak }), Object.keys(leak)[0]).toBe(false);
  }
  expect(SeriesPart.allows({ ordinal: 2, state: 'visible' })).toBe(false);
});
