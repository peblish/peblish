/**
 * Whether a peer's revision dated `incoming` (its `updated`) arrived out of order: before the
 * edit time we hold. No `updated`, or no edit time held, is never out of order; an equal time is
 * not either. The one rule for every Update of remote content that would change what we hold:
 * an edit (posts/remote.ts, comments/remote.ts) and a withdrawal that removes our copy (the
 * delete mutations' `revision`, judged on the rows their recheck locked).
 */
export const olderThanHeld = (incoming: Date | null, held: Date | null): boolean => incoming !== null && held !== null && incoming < held;
