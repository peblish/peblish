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

test('Joined holds the sidebar’s matches and the directory’s own joins, by name; the rest keep the directory’s order', () => {
  const groups = finderGroups({
    joined: [tea, kettles],
    found: [
      { actor: teapots, follow: 'none' },
      { actor: kettles, follow: 'pending' },
      { actor: cups, follow: 'accepted' },
      { actor: tea, follow: 'accepted' },
    ],
    query: '',
  });
  expect(groups.joined.map(({ actor: { name }, pending }) => [name, pending])).toEqual([
    ['cups', false],
    ['kettles', true],
    ['tea', false],
  ]);
  expect(groups.others.map(({ actor: { name } }) => name)).toEqual(['teapots']);
});

test('a joined community the text does not match is left out, and never shows twice', () => {
  const groups = finderGroups({ joined: [tea, kettles], found: [{ actor: kettles, follow: 'none' }], query: 'kett' });
  expect(groups.joined.map(({ actor: { name } }) => name)).toEqual(['kettles']);
  expect(groups.others).toEqual([]);
});
