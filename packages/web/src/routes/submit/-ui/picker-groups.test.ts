import { expect, test } from 'vitest';
import type { PickerCommunity } from '../-types.ts';
import { pickerGroups } from './picker-groups.ts';

const community = (id: string, local = true): PickerCommunity => ({
  id,
  handle: local ? id : `${id}@far.example`,
  displayName: null,
  local,
  subscribers: local ? 1 : null,
  canPost: true,
  restricted: false,
});

test('joined first (the sidebar’s communities, local or remote), then the rest', () => {
  const groups = pickerGroups([community('a'), community('b'), community('c'), community('r', false)], new Set(['b', 'r']), false);
  expect(groups.joined.map(({ id }) => id)).toEqual(['b', 'r']);
  expect(groups.others.map(({ id }) => id)).toEqual(['a', 'c']);
  expect(groups.truncated).toBe(false);
});

test('a remote community the loader looked up for the form, one the viewer does not follow, is with the rest', () => {
  const groups = pickerGroups([community('a'), community('r', false), community('lab', false)], new Set(['r']), false);
  expect(groups.joined.map(({ id }) => id)).toEqual(['r']);
  expect(groups.others.map(({ id }) => id)).toEqual(['a', 'lab']);
});

test('the list is cut short when the loader says so, however many of it are local', () => {
  const locals = Array.from({ length: 190 }, (_, index) => community(`c${index}`));
  const remotes = Array.from({ length: 10 }, (_, index) => community(`r${index}`, false));
  expect(pickerGroups([...locals, ...remotes], new Set(), true).truncated).toBe(true);
  const full = Array.from({ length: 200 }, (_, index) => community(`c${index}`));
  expect(pickerGroups(full, new Set(), false).truncated).toBe(false);
});
