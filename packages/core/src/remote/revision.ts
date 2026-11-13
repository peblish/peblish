/**
 * Whether a peer's revision dated `incoming` (its `updated`) arrived out of order: before the
 * edit time we hold. No `updated`, or no edit time held, is never out of order; an equal time is
 * not either. The one rule for every Update of remote content that would change what we hold:
 * an edit (posts/remote.ts, comments/remote.ts) and a withdrawal that removes our copy (the
 * delete mutations' `revision`, judged on the rows their recheck locked).
 */
export const olderThanHeld = (incoming: Date | null, held: Date | null): boolean => incoming !== null && held !== null && incoming < held;

/**
 * The edit time to store for a revision that is applied: the peer's `updated`, or the receive
 * time when it sent none, but never earlier than the edit time held, so the stored time never
 * moves backwards (an undated edit after a future-dated one keeps the future time).
 */
export const nextEditedAt = (incoming: Date | null, held: Date | null): Date => {
  const next = incoming ?? new Date();
  return held !== null && next < held ? held : next;
};
