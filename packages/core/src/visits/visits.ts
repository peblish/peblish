import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { db, type Queryable } from '../db/read.ts';
import type { Result } from '../identity/result.ts';

// The "new since last visit" feature's seam (branch 5). The thread reader (comments/read.ts) asks
// threadVisit for every page of a thread; web records a visit through recordVisitAs. Until the
// feature lands every visit is a first one: threadVisit answers the baseline without a query, and
// recordVisitAs refuses as if the post were not there. The visits lane fills in this file and adds
// its mutation, policy and tests beside it, without touching a reader. The one definition of "new"
// lives here, for every surface: a comment received here (comments.created_at) after the
// boundary of the viewer's visit marker (visits/tables.ts), by someone else, that the viewer is
// shown (live and not by someone they block).

/** A comment of the page being read, as the thread reader has it. `shown`: live, and not by someone the viewer blocks. */
export type VisitComment = { id: Uuid; authorId: Uuid; shown: boolean };

/** What a thread page adds for the viewer's visit: Thread.previousVisitAt and newCount, and CommentView.isNew per comment. */
export type ThreadVisitState = {
  /** When the visit the markers compare against was; null on a first visit (or signed out). */
  previousVisitAt: string | null;
  /** How many comments in the thread are new to the viewer. */
  newCount: number;
  /** Which of the page's comments are new. */
  newIds: ReadonlySet<Uuid>;
};

/** The baseline: a first visit (or a signed-out viewer) shows nothing as new. */
export const firstVisit: ThreadVisitState = { previousVisitAt: null, newCount: 0, newIds: new Set() };

/** The viewer's visit state for a page of the thread of `postId`. Reads only; recording the visit is recordVisitAs's. */
export async function threadVisit(
  _viewerId: Uuid | null,
  _postId: Uuid,
  _comments: readonly VisitComment[],
  _q: Queryable = db(),
): Promise<ThreadVisitState> {
  return firstVisit;
}

/** Records that the principal opened the thread of `postId` now. Never called by a prefetch, a HEAD or a visitor without a session. */
export async function recordVisitAs(_principal: Principal, _input: { postId: Uuid }): Promise<Result<{ recorded: boolean }>> {
  return { ok: false, reason: 'target.not_found' };
}
