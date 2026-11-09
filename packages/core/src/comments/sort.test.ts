import { describe, expect, test } from 'vitest';
import { compareSiblings, hotRank, inDisplayOrder, parseSort, threadSorts, type ThreadSort } from './sort.ts';

const now = new Date('2026-11-09T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const c = (id: string, parentId: string | null, score: number, age: number) => ({
  id,
  parentId,
  upvotes: score,
  downvotes: 0,
  publishedAt: hoursAgo(age),
});

describe('parseSort', () => {
  test('takes the four sorts and falls back to hot for anything else', () => {
    expect(threadSorts.map(parseSort)).toEqual(['hot', 'top', 'new', 'old']);
    for (const junk of [undefined, null, '', 'controversial', 'TOP', ['top'], 1, {}]) expect(parseSort(junk)).toBe('hot');
  });
});

describe('sibling order', () => {
  // A fresh comment with a fair score, an old one with a great score, and a brand new one with none.
  const siblings = [c('old-great', null, 100, 48), c('fresh-fair', null, 10, 1), c('new-none', null, 0, 0)];
  const order = (sort: ThreadSort) => [...siblings].sort(compareSiblings(sort, now)).map(({ id }) => id);

  test.each([
    ['hot', ['fresh-fair', 'new-none', 'old-great']],
    ['top', ['old-great', 'fresh-fair', 'new-none']],
    ['new', ['new-none', 'fresh-fair', 'old-great']],
    ['old', ['old-great', 'fresh-fair', 'new-none']],
  ] as const)('%s', (sort, expected) => {
    expect(order(sort)).toEqual(expected);
  });

  test('hot is the score over the age, as Lemmy ranks it', () => {
    // 10,000 * log10(score + 3) / (hours + 2) ^ 1.8
    expect(hotRank(c('x', null, 10, 1), now)).toBeCloseTo((10_000 * Math.log10(13)) / 3 ** 1.8, 6);
    // A score below -2 does not rank below a score of -2: the logarithm's argument stops at 1.
    expect(hotRank(c('x', null, -50, 1), now)).toBe(0);
  });

  test('equal scores and times keep one order, by id', () => {
    const tied = [c('a', null, 5, 3), c('b', null, 5, 3)];
    expect([...tied].sort(compareSiblings('top', now)).map(({ id }) => id)).toEqual(['b', 'a']);
    expect([...tied].sort(compareSiblings('old', now)).map(({ id }) => id)).toEqual(['a', 'b']);
  });
});

describe('display order', () => {
  // Two top-level comments with replies of their own, a reply with a reply.
  const rows = [c('a', null, 1, 10), c('a1', 'a', 5, 9), c('a2', 'a', 9, 8), c('a2x', 'a2', 0, 7), c('b', null, 8, 6), c('b1', 'b', 2, 5)];

  test('is depth first: each comment is followed by what is under it, siblings by the sort', () => {
    expect(inDisplayOrder(rows, 'top', now).map(({ id }) => id)).toEqual(['b', 'b1', 'a', 'a2', 'a2x', 'a1']);
    expect(inDisplayOrder(rows, 'old', now).map(({ id }) => id)).toEqual(['a', 'a1', 'a2', 'a2x', 'b', 'b1']);
    expect(inDisplayOrder(rows, 'new', now).map(({ id }) => id)).toEqual(['b', 'b1', 'a', 'a2', 'a2x', 'a1']);
  });

  test('a row whose parent is not in the list is a root, so a subtree starts at its top and nothing is dropped', () => {
    const subtree = rows.filter(({ id }) => id.startsWith('a2'));
    expect(inDisplayOrder(subtree, 'hot', now).map(({ id }) => id)).toEqual(['a2', 'a2x']);
    const orphans = [c('x', 'gone', 1, 1), c('y', 'gone', 2, 2)];
    expect(inDisplayOrder(orphans, 'top', now).map(({ id }) => id)).toEqual(['y', 'x']);
  });

  test('a chain 50 deep is one run', () => {
    const chain = Array.from({ length: 50 }, (_, level) => c(`c${level}`, level === 0 ? null : `c${level - 1}`, 0, level));
    expect(inDisplayOrder(chain, 'hot', now).map(({ id }) => id)).toEqual(chain.map(({ id }) => id));
  });
});
