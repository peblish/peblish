import { notificationKinds } from '@peblish/core/notifications/view';
import { expect, test } from 'vitest';
import { catalogues } from '../../registry/i18n.gen.ts';
import { inboxAction, inboxHref, parseInboxSearch, watchAction } from './-search.ts';

test('the notifications catalogue has the same keys in en and de, and a type label for every kind', () => {
  expect(Object.keys(catalogues.notifications.de).sort()).toEqual(Object.keys(catalogues.notifications.en).sort());
  for (const kind of notificationKinds) expect(catalogues.notifications.en).toHaveProperty(`type.${kind}`);
});

// The router's Link types the input through this phantom key (SearchSchemaInput); it is never read.
const raw = (search: { filter?: unknown; cursor?: unknown; error?: unknown; marked?: unknown; batch?: unknown; restored?: unknown }) => ({
  ...search,
  __TSearchSchemaInput__: 'TSearchSchemaInput' as const,
});

test('the address keeps a known filter, a cursor that is an id and a short reason, and drops anything else', () => {
  const id = '01a1c000-6346-7c25-9b03-df50f616f738';
  expect(parseInboxSearch(raw({ filter: 'unread', cursor: id, error: 'target.not_found' }))).toEqual({
    filter: 'unread',
    cursor: id,
    error: 'target.not_found',
  });
  expect(parseInboxSearch(raw({ filter: 'everything', cursor: 'nonsense', error: 'x'.repeat(61) }))).toEqual({
    filter: undefined,
    cursor: undefined,
    error: undefined,
  });
  expect(parseInboxSearch(raw({ filter: 7, cursor: 7, error: 7 }))).toEqual({ filter: undefined, cursor: undefined, error: undefined });
});

test('the inbox address leaves out what is default', () => {
  expect(inboxHref()).toBe('/notifications');
  expect(inboxHref({ filter: 'all' })).toBe('/notifications');
  expect(inboxHref({ filter: 'mentions' })).toBe('/notifications?filter=mentions');
  expect(inboxHref({ filter: 'replies', cursor: 'abc', error: 'invalid' })).toBe('/notifications?filter=replies&cursor=abc&error=invalid');
});

test('a form posts its intent, notice and page in the address', () => {
  expect(inboxAction({ intent: 'read_all' })).toBe('/notifications?intent=read_all');
  expect(inboxAction({ intent: 'read', id: 'n1' }, { filter: 'replies', cursor: 'c1' })).toBe(
    '/notifications?intent=read&id=n1&filter=replies&cursor=c1',
  );
});

test('after Mark all read the address carries its count and Undo stamp together, and after the Undo how many came back', () => {
  const batch = '1795332261796250';
  // The router may hand the numbers over already read as numbers.
  expect(parseInboxSearch(raw({ marked: '3', batch }))).toMatchObject({ marked: 3, batch: Number(batch) });
  expect(parseInboxSearch(raw({ marked: 3, batch: Number(batch) }))).toMatchObject({ marked: 3, batch: Number(batch) });
  // One without the other is neither; a stamp that is not digits, or a count of 0 marked, is dropped.
  expect(parseInboxSearch(raw({ marked: '0', batch }))).toMatchObject({ marked: undefined, batch: undefined });
  expect(parseInboxSearch(raw({ marked: '3' }))).toMatchObject({ marked: undefined, batch: undefined });
  expect(parseInboxSearch(raw({ batch }))).toMatchObject({ marked: undefined, batch: undefined });
  expect(parseInboxSearch(raw({ marked: '3', batch: '12 or 1' }))).toMatchObject({ marked: undefined, batch: undefined });
  // An Undo that found nothing left says so without scripts too: none came back.
  expect(parseInboxSearch(raw({ restored: '0' }))).toMatchObject({ restored: 0 });
  expect(parseInboxSearch(raw({ restored: '00' }))).toMatchObject({ restored: undefined });
  expect(inboxHref({ restored: 0 })).toBe('/notifications?restored=0');
  expect(parseInboxSearch(raw({ restored: '2' }))).toMatchObject({ restored: 2 });
  expect(inboxHref({ filter: 'replies', marked: 3, batch: Number(batch) })).toBe(`/notifications?filter=replies&marked=3&batch=${batch}`);
  expect(inboxHref({ restored: 2 })).toBe('/notifications?restored=2');
  expect(inboxAction({ intent: 'undo_read_all', batch }, { filter: 'replies' })).toBe(
    `/notifications?intent=undo_read_all&batch=${batch}&filter=replies`,
  );
  // The Undo carries its count, so a refused one can go back to its status row.
  expect(inboxAction({ intent: 'undo_read_all', batch, marked: 3 }, { filter: 'replies' })).toBe(
    `/notifications?intent=undo_read_all&batch=${batch}&marked=3&filter=replies`,
  );
  expect(watchAction('watch', 'p1')).toBe('/notifications?intent=watch&post=p1');
});
