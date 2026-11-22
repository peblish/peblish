import { expect, test } from 'vitest';
import { shownSaved } from './use-row-save.ts';

// A feed row's own Save answer holds only for the data it was given on: the same viewer, the same state.
test('a row shows its own answer only for the same viewer’s data', () => {
  const mine = { viewer: 'a', given: false, saved: true };
  expect(shownSaved(mine, { viewer: 'a', given: false })).toBe(true);
  expect(shownSaved(null, { viewer: 'a', given: false })).toBe(false);
  // Another account's data and a changed state are the truth.
  expect(shownSaved(mine, { viewer: 'b', given: false })).toBe(false);
  expect(shownSaved(mine, { viewer: '', given: false })).toBe(false);
  expect(shownSaved({ ...mine, saved: false }, { viewer: 'a', given: true })).toBe(true);
});
