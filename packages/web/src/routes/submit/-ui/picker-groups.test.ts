import { expect, test } from 'vitest';
import type { PickerCommunity } from '../-types.ts';
import { localCap, pickerGroups } from './picker-groups.ts';

const community = (id: string, local = true): PickerCommunity => ({
  id,
  handle: local ? id : `${id}@far.example`,
  displayName: null,
  local,
  subscribers: local ? 1 : null,
  canPost: true,
  restricted: false,
});

test('joined first (the sidebar’s locals, and every remote one, which is listed only when followed), then the rest', () => {
  const groups = pickerGroups([community('a'), community('b'), community('c'), community('r', false)], new Set(['b']));
  expect(groups.joined.map(({ id }) => id)).toEqual(['b', 'r']);
  expect(groups.others.map(({ id }) => id)).toEqual(['a', 'c']);
  expect(groups.truncated).toBe(false);
});

test('a full local list says it may be cut short', () => {
  const locals = Array.from({ length: localCap }, (_, index) => community(`c${index}`));
  expect(pickerGroups(locals, new Set()).truncated).toBe(true);
  expect(pickerGroups(locals.slice(1), new Set()).truncated).toBe(false);
});
