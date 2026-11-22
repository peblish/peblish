import type { PostView } from '@peblish/schema/views';
import { expect, test } from 'vitest';
import type { FeedItem } from './items.ts';
import { acknowledgedVotes, acknowledgeVote, askedNow, recount, withVotes } from './votes.ts';

const counts = (upvotes: number) => ({ upvotes, downvotes: 0, comments: 0 }) as PostView['counts'];
const item = (id: string, myVote: PostView['myVote'], upvotes: number): FeedItem => ({
  post: { id, title: id, myVote, counts: counts(upvotes) } as PostView,
  thumbnailSrc: null,
});
const shown = (items: FeedItem[], asked: number) =>
  withVotes(acknowledgedVotes(), items, asked).map(({ post }) => [post.myVote, post.counts.upvotes]);

test('a vote acknowledged after an answer was asked for is laid over it; an answer asked for after the vote stands', () => {
  // The browser: askedNow counts only where there is a window.
  Object.assign(globalThis, { window: globalThis });
  try {
    const before = askedNow();
    acknowledgeVote('up', 1, counts(8));
    // A take-back on content the gate withholds answers no tally: the row's counts, less the reader's vote.
    acknowledgeVote('back', 0, recount(counts(5), 1, 0));
    const after = askedNow();
    const answer = [item('up', 0, 7), item('back', 1, 5), item('other', 0, 3)];
    expect(shown(answer, before)).toEqual([
      [1, 8],
      [0, 4],
      [0, 3],
    ]);
    // Asked for after the votes: the server's own, newer state.
    expect(shown([item('up', 1, 9), item('back', 0, 4)], after)).toEqual([
      [1, 9],
      [0, 4],
    ]);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test("with no tally, only the reader's own vote moves", () => {
  const before = { upvotes: 5, downvotes: 2, comments: 3 };
  expect(recount(before, 1, 0)).toEqual({ upvotes: 4, downvotes: 2, comments: 3 });
  expect(recount(before, 1, -1)).toEqual({ upvotes: 4, downvotes: 3, comments: 3 });
  expect(recount(before, 0, 1)).toEqual({ upvotes: 6, downvotes: 2, comments: 3 });
  expect(recount(before, -1, -1)).toEqual(before);
});
