import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';
import { describe, expect, test } from 'vitest';
import { isWithheld, postForViewer, replyTargetName, tombstoneWord } from './-withheld.ts';

// The post page's data for a removed or deleted post (loadPost sends postForViewer's answer): no
// author, badge, own address or series for anyone but the author and the moderators.

const origin = 'https://feddit.test';
const carol: ActorRef = {
  id: '019a0000-0000-7000-8000-0000000ca201',
  apId: 'https://other.example/users/carol',
  kind: 'Person',
  name: 'carol',
  displayName: 'Carol in full',
  local: false,
  handle: 'carol@other.example',
};
const reader = '019a0000-0000-7000-8000-0000000eade5';

const post = (extra: Partial<PostView>): PostView => ({
  id: '019a0000-0000-7000-8000-000000000b05',
  apId: 'https://other.example/users/carol/statuses/9',
  title: '',
  url: null,
  urlContentType: null,
  thumbnailUrl: null,
  contentHtml: null,
  excerpt: null,
  author: carol,
  authorBadge: 'moderator',
  community: {
    id: '019a0000-0000-7000-8000-0000000c0111',
    apId: `${origin}/c/news`,
    kind: 'Group',
    name: 'news',
    displayName: null,
    local: true,
    handle: 'news',
  },
  publishedAt: '2026-11-01T00:00:00.000Z',
  editedAt: null,
  sensitive: false,
  nsfl: false,
  locked: false,
  featured: false,
  deleted: false,
  removed: false,
  counts: { upvotes: 0, downvotes: 0, comments: 0 },
  myVote: 0,
  series: { id: '019a0000-0000-7000-8000-000000000555', title: 'Carol’s diary', ordinal: 2, total: 3, previous: null, next: null },
  ...extra,
});

describe.each([{ removed: true }, { deleted: true }, { removed: true, deleted: true }])('a post %o', (state) => {
  test('names no author to a reader, signed in or out', () => {
    for (const id of [reader, null]) {
      const shown = postForViewer({ view: post(state), moderator: false }, id);
      const text = JSON.stringify(shown);
      for (const trace of [carol.id, carol.name, carol.displayName!, carol.handle, carol.apId, 'Carol’s diary'])
        expect([id, trace, text.includes(trace)]).toEqual([id, trace, false]);
      expect([isWithheld(shown.author), shown.authorBadge, shown.apId, 'series' in shown]).toEqual([true, null, '', false]);
    }
  });

  test('is as before for its author and for the moderators', () => {
    expect(postForViewer({ view: post(state), moderator: false }, carol.id)).toEqual(post(state));
    expect(postForViewer({ view: post(state), moderator: true }, reader)).toEqual(post(state));
  });
});

test('a live post is as before', () => {
  expect(postForViewer({ view: post({}), moderator: false }, reader)).toEqual(post({}));
  expect(isWithheld(carol)).toBe(false);
});

test('a tombstone is named as its row names it: removed when both flags are set', () => {
  const labels = { removed: '[removed]', deleted: '[deleted]' };
  expect(tombstoneWord({ removed: true, deleted: true }, labels)).toBe('[removed]');
  expect(tombstoneWord({ removed: true, deleted: false }, labels)).toBe('[removed]');
  expect(tombstoneWord({ removed: false, deleted: true }, labels)).toBe('[deleted]');
});

test('the reply bar names a tombstone by its word for everyone, staff too, as its row does; a live comment by its handle', () => {
  const labels = { removed: '[removed]', deleted: '[deleted]' };
  const handle = (raw: string) => `@${raw}`;
  const comment = (flags: Pick<CommentView, 'removed' | 'deleted'>) => ({ ...flags, author: carol });
  // As a moderator gets it: told who wrote it, though the row draws no author.
  expect(replyTargetName(comment({ removed: false, deleted: true }), labels, handle)).toBe('[deleted]');
  expect(replyTargetName(comment({ removed: true, deleted: true }), labels, handle)).toBe('[removed]');
  expect(replyTargetName(comment({ removed: true, deleted: false }), labels, handle)).toBe('[removed]');
  // As anyone else gets one: no author at all.
  expect(
    replyTargetName({ removed: false, deleted: true, author: { ...carol, id: '00000000-0000-0000-0000-000000000000' } }, labels, handle),
  ).toBe('[deleted]');
  expect(replyTargetName(comment({ removed: false, deleted: false }), labels, handle)).toBe('@carol@other.example');
});
