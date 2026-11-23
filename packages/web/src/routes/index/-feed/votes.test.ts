import type { PostView } from '@peblish/schema/views';
import { expect, test } from 'vitest';
import type { FeedItem } from './items.ts';
import { acknowledgedVotes, acknowledgeVote, askedNow, withVotes } from './votes.ts';

const item = (id: string, myVote: PostView['myVote'], upvotes: number, comments = 0): FeedItem => ({
  post: { id, title: id, myVote, counts: { upvotes, downvotes: 0, comments } } as PostView,
  thumbnailSrc: null,
});
const shown = (items: FeedItem[], asked: number) =>
  withVotes(acknowledgedVotes(), items, asked).map(({ post }) => [post.myVote, post.counts.upvotes, post.counts.comments]);

/** Runs `body` as in the browser, where askedNow counts (on the server it is always 0). */
function inBrowser(body: () => void) {
  Object.assign(globalThis, { window: globalThis });
  try {
    body();
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

test('a vote acknowledged after an answer was asked for is laid over it; an answer asked for after the vote stands', () =>
  inBrowser(() => {
    const before = askedNow();
    acknowledgeVote('up', 1, { upvotes: 8, downvotes: 0 });
    const after = askedNow();
    expect(shown([item('up', 0, 7), item('other', 0, 3)], before)).toEqual([
      [1, 8, 0],
      [0, 3, 0],
    ]);
    expect(shown([item('up', 1, 9)], after)).toEqual([[1, 9, 0]]);
  }));

test("the overlay changes the vote and its tally only: the rest of the row is the fresh answer's", () =>
  inBrowser(() => {
    const before = askedNow();
    acknowledgeVote('commented', 1, { upvotes: 6, downvotes: 0 });
    // Asked for before the vote and answered after a comment: the comment count is the answer's.
    expect(shown([item('commented', 0, 5, 1)], before)).toEqual([[1, 6, 1]]);
  }));

test("with no tally, only the reader's own vote moves, from the vote the fresh row holds", () =>
  inBrowser(() => {
    const before = askedNow();
    acknowledgeVote('back', 0, null);
    acknowledgeVote('down', -1, null);
    // The answer still has the reader's upvote: taken back, it leaves the score.
    expect(shown([item('back', 1, 5, 2)], before)).toEqual([[0, 4, 2]]);
    // An answer that already holds the vote (it was saved before the read was) is not moved twice.
    expect(shown([item('back', 0, 4)], before)).toEqual([[0, 4, 0]]);
    expect(withVotes(acknowledgedVotes(), [item('down', 1, 5)], before)[0]!.post.counts).toEqual({ upvotes: 4, downvotes: 1, comments: 0 });
  }));
