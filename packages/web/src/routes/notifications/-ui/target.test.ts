import { expect, test } from 'vitest';
import { noticeTarget } from './target.ts';

// Where a row's link goes: the comment or the post, or, for a reply or mention that withholds
// its post, the community it is in.

const community = { id: 'c', name: 'news', displayName: null, handle: 'news@lemmy.test', local: false };
const row = (extra: Partial<Parameters<typeof noticeTarget>[0]>) =>
  noticeTarget({ kind: 'mention', postId: null, commentId: null, community, ...extra });

test('the comment, the post, or the community when the post is withheld', () => {
  expect(row({ kind: 'reply', postId: 'p', commentId: 'k' })).toBe('/post/p/comments/k');
  expect(row({ postId: 'p' })).toBe('/post/p');
  expect(row({})).toBe('/c/news@lemmy.test');
  // A ban names its community in the sentence and links nowhere.
  expect(row({ kind: 'ban' })).toBeNull();
  expect(row({ community: null })).toBeNull();
});
