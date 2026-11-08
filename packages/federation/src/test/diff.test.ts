import { expect, it } from 'vitest';
import { diff, matches } from './diff.ts';

it('treats the JSON-LD equivalences as equal', () => {
  const original = {
    to: 'https://a.test/x',
    cc: ['https://a.test/b', 'https://a.test/c'],
    content: null,
    published: '2026-11-08T02:26:29.236873Z',
    '@context': ['https://www.w3.org/ns/activitystreams', { toot: 'http://joinmastodon.org/ns#' }],
  };
  const mapped = {
    to: ['https://a.test/x'],
    cc: ['https://a.test/c', 'https://a.test/b'],
    published: '2026-11-08T02:26:29.236Z',
    '@context': ['https://www.w3.org/ns/activitystreams', { toot: 'http://joinmastodon.org/ns#' }],
  };
  expect(diff(original, mapped)).toEqual([]);
});

it('reports narrowing, missing, extra and changed values by path', () => {
  const original = {
    to: ['https://a.test/x'],
    tag: [{ name: '#a' }],
    updated: '2026-11-08T02:26:29.236Z',
    '@context': 'https://a.test/ctx',
  };
  const mapped = {
    to: 'https://a.test/x',
    tag: [{ name: '#b' }],
    stickied: false,
    '@context': ['https://a.test/ctx', 'https://b.test/ctx'],
  };
  expect(diff(original, mapped).map(({ path, change }) => `${change} ${path}`)).toEqual([
    'changed @context',
    'added stickied',
    'changed tag[0].name',
    'changed to',
    'dropped updated',
  ]);
  expect(matches('**.tag[].name', 'object.object.tag[3].name')).toBe(true);
  expect(matches('tag', 'object.tag')).toBe(false);
});
