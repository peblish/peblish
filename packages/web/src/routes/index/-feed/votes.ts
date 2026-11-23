import type { PostView } from '@peblish/schema/views';
import type { FeedItem } from './items.ts';

// The votes on posts the server has acknowledged in this browser since the page loaded, from every surface
// that votes on a post (a feed's or a community's rows, the post page, a profile's activity), so an answer
// that was already on its way (a loader reload, a batch) cannot put an older vote back: each answer remembers
// when it was asked for, and a vote acknowledged after that is laid over its post. Only the vote moves: the
// reader's vote and the tally the server answered with, or, with no tally (content the gate now withholds),
// the reader's own vote in the answer's counts. The rest of the row is the answer's. An answer asked for after
// the vote has the server's own, newer state, and wins. Memory only, in the browser; the server keeps nothing.

type Tally = Pick<PostView['counts'], 'upvotes' | 'downvotes'>;
type Vote = { myVote: PostView['myVote']; tally: Tally | null; at: number };

let clock = 0;
/** Replaced, never changed, on each acknowledgement: a list re-renders when it is a new one. */
let votes: ReadonlyMap<string, Vote> = new Map();
const listeners = new Set<() => void>();

/** The moment a read is asked for: 0 on the server, where no vote has been acknowledged. */
export const askedNow = (): number => (typeof window === 'undefined' ? 0 : ++clock);

/** A vote on a post the server acknowledged, with the tally it answered (none when the gate withholds the post). */
export function acknowledgeVote(postId: string, myVote: PostView['myVote'], tally: Tally | null | undefined): void {
  votes = new Map(votes).set(postId, { myVote, tally: tally ? { upvotes: tally.upvotes, downvotes: tally.downvotes } : null, at: ++clock });
  for (const listener of listeners) listener();
}

export function subscribeVotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The votes acknowledged so far, for useSyncExternalStore and withVotes. */
export const acknowledgedVotes = (): ReadonlyMap<string, Vote> => votes;

const none: ReadonlyMap<string, Vote> = new Map();
/** None, as the server renders a list (useSyncExternalStore's server snapshot). */
export const noVotes = (): ReadonlyMap<string, Vote> => none;

/** `counts` once the reader's own vote moves from `from` to `to`, the others' votes as they were. */
const recount = (counts: PostView['counts'], from: PostView['myVote'], to: PostView['myVote']): PostView['counts'] => ({
  ...counts,
  upvotes: counts.upvotes + Number(to === 1) - Number(from === 1),
  downvotes: counts.downvotes + Number(to === -1) - Number(from === -1),
});

/** An answer's items as the reader should see them: each post with the vote acknowledged after `asked`, if any. */
export const withVotes = <T extends FeedItem>(votes: ReadonlyMap<string, Vote>, items: readonly T[], asked: number): T[] =>
  items.map((item) => {
    const vote = votes.get(item.post.id);
    if (!vote || vote.at <= asked) return item;
    const { post } = item;
    // Without a tally the move is worked out against the answer's own vote, so a vote it already counts is not counted twice.
    const counts = vote.tally ? { ...post.counts, ...vote.tally } : recount(post.counts, post.myVote, vote.myVote);
    return { ...item, post: { ...post, myVote: vote.myVote, counts } };
  });
