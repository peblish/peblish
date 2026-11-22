import type { InboxItem } from '@peblish/core/notifications/view';
import { expect, test } from 'vitest';
import { groupNotices, groupOf } from './groups.tsx';

// The inbox's date groups: a notice's age against the page's clock, as Commons' mock reckons it.

const now = '2026-11-22T12:00:00.000Z';
const ago = (hours: number) => new Date(Date.parse(now) - hours * 3_600_000).toISOString();

test('under a day is Today, under two Yesterday, under seven This week, then Earlier', () => {
  expect([0, 23.9, 24, 47.9, 48, 167.9, 168, 2000].map((hours) => groupOf(ago(hours), now))).toEqual([
    'today',
    'today',
    'yesterday',
    'yesterday',
    'week',
    'week',
    'earlier',
    'earlier',
  ]);
});

test('groups keep the page’s order inside them, come in date order and leave out the empty ones', () => {
  const item = (id: string, hours: number) => ({ id, createdAt: ago(hours) }) as InboxItem;
  const groups = groupNotices([item('a', 1), item('b', 3), item('c', 200), item('d', 30)], now);
  expect(groups.map(({ group, items }) => [group, items.map(({ id }) => id)])).toEqual([
    ['today', ['a', 'b']],
    ['yesterday', ['d']],
    ['earlier', ['c']],
  ]);
});
