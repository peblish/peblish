import { expect, test } from 'vitest';
import { catalogues } from '../../../registry/i18n.gen.ts';
import { feedHref, parseFeedSearch, resolveFeedSearch } from './search.ts';

test('the feeds catalogue has the same keys in en and de', () => {
  expect(Object.keys(catalogues.feeds.de).sort()).toEqual(Object.keys(catalogues.feeds.en).sort());
});

// The router's Link types the input through this phantom key (SearchSchemaInput); it is never read.
const raw = (search: { sort?: string; period?: string; cursor?: string; n?: unknown }) => ({
  ...search,
  __TSearchSchemaInput__: 'TSearchSchemaInput' as const,
});

test('a feed address keeps what is valid, drops the rest, and defaults are applied after', () => {
  expect(parseFeedSearch(raw({ sort: 'top', period: 'week', cursor: 'abc' }))).toEqual({
    sort: 'top',
    period: 'week',
    cursor: 'abc',
    n: undefined,
  });
  const dropped = parseFeedSearch(raw({ sort: 'controversial', period: 'fortnight', cursor: '' }));
  // Named and undefined, not absent: the router lays the result over the raw address.
  expect(dropped).toEqual({ sort: undefined, period: undefined, cursor: undefined, n: undefined });
  expect(resolveFeedSearch(dropped)).toEqual({ sort: 'hot', period: 'day', cursor: undefined });
});

test('links leave out the defaults and carry the cursor', () => {
  expect(feedHref('/all', { sort: 'hot', period: 'day' })).toBe('/all');
  expect(feedHref('/all', { sort: 'new', period: 'week' })).toBe('/all?sort=new');
  expect(feedHref('/', { sort: 'top', period: 'week', cursor: 'c1' })).toBe('/?sort=top&period=week&cursor=c1');
});

test('the rows an address asks for are whole batches, at most 200; anything else is one batch', () => {
  const n = (value: unknown) => parseFeedSearch(raw({ n: value })).n;
  expect([n(80), n('80'), n(200), n(280), n(260)]).toEqual([80, 80, 200, 200, 200]);
  expect([n(20), n(7), n('abc'), n(-20), n(0), n(40.5), n('4e1'), n(undefined)]).toEqual(Array(8).fill(undefined));
  expect(feedHref('/', { sort: 'new', period: 'day', n: 80 })).toBe('/?sort=new&n=80');
  expect(feedHref('/', { sort: 'new', period: 'day', n: 20 })).toBe('/?sort=new');
});
