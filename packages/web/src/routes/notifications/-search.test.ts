import { notificationKinds } from '@peblish/core/notifications/view';
import { expect, test } from 'vitest';
import { catalogues } from '../../registry/i18n.gen.ts';
import { inboxAction, inboxHref, parseInboxSearch } from './-search.ts';

test('the notifications catalogue has the same keys in en and de, and a type label for every kind', () => {
  expect(Object.keys(catalogues.notifications.de).sort()).toEqual(Object.keys(catalogues.notifications.en).sort());
  for (const kind of notificationKinds) expect(catalogues.notifications.en).toHaveProperty(`type.${kind}`);
});

// The router's Link types the input through this phantom key (SearchSchemaInput); it is never read.
const raw = (search: { filter?: unknown; cursor?: unknown; error?: unknown }) => ({
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
