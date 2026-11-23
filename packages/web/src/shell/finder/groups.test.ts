import type { ActorRef } from '@peblish/schema/views';
import { expect, test } from 'vitest';
import { finderGroups, matches } from './groups.ts';

const actor = (name: string, host: string | null, displayName: string | null = null): ActorRef => ({
  id: `id-${name}`,
  apId: `https://${host ?? 'here.example'}/c/${name}`,
  kind: 'Group',
  name,
  displayName,
  local: host === null,
  handle: host === null ? name : `${name}@${host}`,
});

const tea = actor('tea', null, 'Tea Rooms');
const kettles = actor('kettles', 'brew.example', 'Kettles');
const teapots = actor('teapots', 'brew.example');
const cups = actor('cups', null);

test('a community answers by name, display name or handle with its host, in any case, accents and a "!" aside', () => {
  expect(matches(tea, 'ROOMS')).toBe(true);
  expect(matches(kettles, '!kettles@brew')).toBe(true);
  expect(matches(kettles, 'brew.example')).toBe(true);
  expect(matches(actor('cafe', null, 'Café'), 'cafe')).toBe(true);
  expect(matches(tea, 'kettle')).toBe(false);
  expect(matches(tea, '  ')).toBe(true);
});

test('Joined holds the viewer’s own communities the server listed, by name; the rest keep the directory’s order', () => {
  const groups = finderGroups({
    followed: [
      { actor: tea, follow: 'accepted' },
      { actor: kettles, follow: 'pending' },
    ],
    found: [
      { actor: teapots, follow: 'none' },
      { actor: kettles, follow: 'pending' },
      { actor: cups, follow: 'none' },
    ],
    query: '',
  });
  expect(groups.joined.map(({ actor: { name }, pending }) => [name, pending])).toEqual([
    ['kettles', true],
    ['tea', false],
  ]);
  expect(groups.others.map(({ actor: { name } }) => name)).toEqual(['teapots', 'cups']);
});

test('one of the viewer’s own that the server left out of their list is not drawn from the directory’s answer either', () => {
  // The directory still lists a community the viewer blocked, with their follow (its reader leaves personal blocks to its callers).
  const groups = finderGroups({
    followed: [],
    found: [
      { actor: tea, follow: 'accepted' },
      { actor: cups, follow: 'none' },
    ],
    query: '',
  });
  expect(groups.joined).toEqual([]);
  expect(groups.others.map(({ actor: { name } }) => name)).toEqual(['cups']);
});

test('one of the viewer’s own the text does not match is left out, and none shows twice', () => {
  const groups = finderGroups({
    followed: [
      { actor: tea, follow: 'accepted' },
      { actor: kettles, follow: 'accepted' },
    ],
    found: [{ actor: kettles, follow: 'accepted' }],
    query: 'kett',
  });
  expect(groups.joined.map(({ actor: { name } }) => name)).toEqual(['kettles']);
  expect(groups.others).toEqual([]);
});
