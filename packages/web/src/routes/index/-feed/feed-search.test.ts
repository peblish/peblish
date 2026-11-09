import { expect, test } from 'vitest';
import { catalogues } from '../../../registry/i18n.gen.ts';
import { feedHref, parseFeedSearch, resolveFeedSearch } from './search.ts';

test('the feeds catalogue has the same keys in en and de', () => {
  expect(Object.keys(catalogues.feeds.de).sort()).toEqual(Object.keys(catalogues.feeds.en).sort());
});

// The router's Link types the input through this phantom key (SearchSchemaInput); it is never read.
const raw = (search: { sort?: string; period?: string; cursor?: string }) => ({
  ...search,
  __TSearchSchemaInput__: 'TSearchSchemaInput' as const,
});

test('a feed address keeps what is valid, drops the rest, and defaults are applied after', () => {
  expect(parseFeedSearch(raw({ sort: 'top', period: 'week', cursor: 'abc' }))).toEqual({ sort: 'top', period: 'week', cursor: 'abc' });
  const dropped = parseFeedSearch(raw({ sort: 'controversial', period: 'fortnight', cursor: '' }));
  // Named and undefined, not absent: the router lays the result over the raw address.
  expect(dropped).toEqual({ sort: undefined, period: undefined, cursor: undefined });
  expect(resolveFeedSearch(dropped)).toEqual({ sort: 'hot', period: 'day', cursor: undefined });
});

test('links leave out the defaults and carry the cursor', () => {
  expect(feedHref('/all', { sort: 'hot', period: 'day' })).toBe('/all');
  expect(feedHref('/all', { sort: 'new', period: 'week' })).toBe('/all?sort=new');
  expect(feedHref('/', { sort: 'top', period: 'week', cursor: 'c1' })).toBe('/?sort=top&period=week&cursor=c1');
});
