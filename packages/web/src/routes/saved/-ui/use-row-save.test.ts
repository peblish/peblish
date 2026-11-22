import { expect, test } from 'vitest';
import { shownSaved } from './use-row-save.ts';

// A feed row's own Save answer holds only for the data it was given on: the same viewer, the same load, the same state.
test('a row shows its own answer only while the data is the same viewer’s same load', () => {
  const mine = { viewer: 'a', read: 1, given: false, saved: true };
  expect(shownSaved(mine, { viewer: 'a', read: 1, given: false })).toBe(true);
  expect(shownSaved(null, { viewer: 'a', read: 1, given: false })).toBe(false);
  // Another account's data, a fresh load and a changed state are the truth.
  expect(shownSaved(mine, { viewer: 'b', read: 1, given: false })).toBe(false);
  expect(shownSaved(mine, { viewer: 'a', read: 2, given: false })).toBe(false);
  expect(shownSaved({ ...mine, saved: false }, { viewer: 'a', read: 1, given: true })).toBe(true);
});
