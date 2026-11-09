import { describe, expect, test } from 'vitest';
import { parseSort, threadSorts } from './sort.ts';

// The order of siblings is SQL (siblings.ts), tested through the database in read.test.ts.
describe('parseSort', () => {
  test('takes the four sorts and falls back to hot for anything else', () => {
    expect(threadSorts.map(parseSort)).toEqual(['hot', 'top', 'new', 'old']);
    for (const junk of [undefined, null, '', 'controversial', 'TOP', ['top'], 1, {}]) expect(parseSort(junk)).toBe('hot');
  });
});
