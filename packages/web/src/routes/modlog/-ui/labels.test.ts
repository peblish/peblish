import type { LineView } from '../-load.ts';
import { expect, test } from 'vitest';
import { actionKey, banLength } from './labels.ts';

const post = { kind: 'post', postId: null, apId: '', label: null, author: null } as const;
const comment = { kind: 'comment', commentId: null, postId: null, apId: '', label: null, author: null } as const;

test('an action is named by its own message, by its target kind, by its family, or generically', () => {
  expect(actionKey('mod.remove', post)).toBe('action.mod.remove.post');
  expect(actionKey('mod.remove', comment)).toBe('action.mod.remove.comment');
  expect(actionKey('mod.lock', post)).toBe('action.mod.lock');
  expect(actionKey('mod.site_ban', null)).toBe('action.mod.site_ban');
  expect(actionKey('settings.something_new', null)).toBe('action.settings');
  expect(actionKey('page.publish', null)).toBe('action.page.publish');
  expect(actionKey('mod.invented', null)).toBe('action.mod');
  expect(actionKey('unheard.of', null)).toBe('action.other');
});

test('a ban is permanent, a number of days, or an end date under a day', () => {
  const line = (action: string, expiresAt?: string | null, createdAt = '2026-11-09T10:00:00.000Z') =>
    ({ entry: { action, createdAt, details: { expiresAt } } }) as unknown as LineView;
  expect(banLength(line('mod.ban', null))).toEqual({ kind: 'permanent' });
  expect(banLength(line('mod.ban'))).toEqual({ kind: 'permanent' });
  expect(banLength(line('mod.site_ban', '2026-11-16T10:00:00.000Z'))).toEqual({ kind: 'days', count: 7 });
  expect(banLength(line('mod.ban', '2026-11-09T18:00:00.000Z'))).toEqual({ kind: 'until', at: '2026-11-09T18:00:00.000Z' });
  expect(banLength(line('mod.remove'))).toBeNull();
});
