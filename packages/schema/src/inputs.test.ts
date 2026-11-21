import { type } from 'arktype';
import { expect, test } from 'vitest';
import { SearchQuery } from './inputs.ts';

test('a search query is trimmed, 2 to 100 characters, with no cursor on the first page', () => {
  expect(SearchQuery({ q: '  rust  ' })).toEqual({ q: 'rust', cursor: null });
  expect(SearchQuery({ q: 'ab', cursor: 'next' })).toEqual({ q: 'ab', cursor: 'next' });
  for (const q of [' a ', '   ', 'x'.repeat(101)]) expect(SearchQuery({ q }) instanceof type.errors, JSON.stringify(q)).toBe(true);
});
