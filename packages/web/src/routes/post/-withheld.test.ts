import type { ActorRef, PostView } from '@peblish/schema/views';
import { describe, expect, test } from 'vitest';
import { authorWithheld, postAsShown } from './-withheld.ts';

// The post page's data for a removed or deleted post (loadPost sends postAsShown's answer): no
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
      const shown = postAsShown(post(state), { id, moderator: false }, origin);
      const text = JSON.stringify(shown);
      for (const trace of [carol.id, carol.name, carol.displayName!, carol.handle, carol.apId, 'Carol’s diary'])
        expect([id, trace, text.includes(trace)]).toEqual([id, trace, false]);
      expect([authorWithheld(shown.author), shown.authorBadge, shown.apId]).toEqual([true, null, `${origin}/ap/post/${shown.id}`]);
    }
  });

  test('is as before for its author and for the moderators', () => {
    expect(postAsShown(post(state), { id: carol.id, moderator: false }, origin)).toEqual(post(state));
    expect(postAsShown(post(state), { id: reader, moderator: true }, origin)).toEqual(post(state));
  });
});

test('a live post is as before', () => {
  expect(postAsShown(post({}), { id: reader, moderator: false }, origin)).toEqual(post({}));
  expect(authorWithheld(carol)).toBe(false);
});
