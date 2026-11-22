import type { PostView } from '@peblish/schema/views';
import type { FeedItem } from './items.ts';

// The votes the server has acknowledged in this browser since the page loaded, so an answer that was
// already on its way (a loader reload, a batch) cannot put an older vote back: each answer remembers when
// it was asked for, and a vote acknowledged after that is laid over its post. An answer asked for after the
// vote has the server's own, newer state, and wins. Memory only, in the browser; the server keeps nothing.

type Vote = { myVote: PostView['myVote']; counts: PostView['counts']; at: number };

let clock = 0;
/** Replaced, never changed, on each acknowledgement: a list re-renders when it is a new one. */
let votes: ReadonlyMap<string, Vote> = new Map();
const listeners = new Set<() => void>();

/** The moment a read is asked for: 0 on the server, where no vote has been acknowledged. */
export const askedNow = (): number => (typeof window === 'undefined' ? 0 : ++clock);

/** A vote the server acknowledged, with the counts the row has since. */
export function acknowledgeVote(postId: string, myVote: PostView['myVote'], counts: PostView['counts']): void {
  votes = new Map(votes).set(postId, { myVote, counts, at: ++clock });
  for (const listener of listeners) listener();
}

/**
 * The counts once the reader's own vote moves from `from` to `to`, the others' as they were: for an answer
 * with no tally (a vote on content the gate now withholds), so the row keeps the score it shows.
 */
export const recount = (counts: PostView['counts'], from: PostView['myVote'], to: PostView['myVote']): PostView['counts'] => ({
  ...counts,
  upvotes: counts.upvotes + Number(to === 1) - Number(from === 1),
  downvotes: counts.downvotes + Number(to === -1) - Number(from === -1),
});

export function subscribeVotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The votes acknowledged so far, for useSyncExternalStore and withVotes. */
export const acknowledgedVotes = (): ReadonlyMap<string, Vote> => votes;

const none: ReadonlyMap<string, Vote> = new Map();
/** None, as the server renders a list (useSyncExternalStore's server snapshot). */
export const noVotes = (): ReadonlyMap<string, Vote> => none;

/** An answer's items as the reader should see them: each post with the vote acknowledged after `asked`, if any. */
export const withVotes = <T extends FeedItem>(votes: ReadonlyMap<string, Vote>, items: readonly T[], asked: number): T[] =>
  items.map((item) => {
    const vote = votes.get(item.post.id);
    return vote && vote.at > asked ? { ...item, post: { ...item.post, myVote: vote.myVote, counts: vote.counts } } : item;
  });
