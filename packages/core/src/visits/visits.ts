import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { sql, type SQL } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { actorBlockedBy } from '../blocks/predicate.ts';
import { db, type Queryable } from '../db/read.ts';
import { comments } from '../db/tables/content.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { recordVisit, visitWindow } from './record.ts';
import { threadVisits } from './tables.ts';

// "New since last visit" (branch 5). The thread reader (comments/read.ts) asks threadVisit for
// every page of a thread; web records a visit through recordVisitAs, in a POST the page sends
// once it is on screen (routes/post/-visit.ts), so reading never writes. The one definition of
// "new", for every surface, is newBoundary plus newTo below: a comment received here
// (comments.created_at) after the boundary of the viewer's marker, by someone else, live, and
// not by someone the viewer blocks.
//
// A visit lasts `visitWindow` from its start: a marker written within it is this visit's, older
// is an earlier one. The page's own read runs before its visit is recorded, and a re-sort, a
// next page or the reload after a reply runs after, so the boundary is the marker's
// previous_visit_at while the marker is this visit's and its last_visit_at while it is an
// earlier one's: either way the visit before this one, and the markers stay put for the whole
// visit. Recording rotates last_visit_at into previous_visit_at only once the window has passed
// (record.ts). Both sides compare on the database clock, in SQL, so no time loses precision in a
// round trip.

/** The marker row's boundary (alias `v`): the visit before the current one; null on a first visit. */
const newBoundary = sql`case when v.last_visit_at > now() - ${visitWindow} then v.previous_visit_at else v.last_visit_at end`;

/** Whether the comment (alias `c`) can be new to the viewer at all: by someone else, live, and not by someone they block. */
function newTo(viewerId: Uuid): SQL {
  return sql`c.author_id <> ${viewerId}::uuid and c.deleted_at is null and c.removed_at is null and not ${actorBlockedBy(viewerId, sql`c.author_id`)}`;
}

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

/**
 * The viewer's visit state for a page of the thread of `postId`, in one query: the count over
 * the whole thread (its comments_post_path range), the marks over the page's comments. Reads only.
 */
export async function threadVisit(
  viewerId: Uuid | null,
  postId: Uuid,
  page: readonly VisitComment[],
  q: Queryable = db(),
): Promise<ThreadVisitState> {
  if (!viewerId) return firstVisit;
  const candidates = page.filter((comment) => comment.shown && comment.authorId !== viewerId).map(({ id }) => id);
  const onPage =
    candidates.length === 0
      ? sql`'[]'::json`
      : sql`(select coalesce(json_agg(c.id), '[]'::json) from ${comments} as c
          where c.post_id = ${postId}::uuid and c.created_at > m.boundary and ${newTo(viewerId)}
          and c.id in (${sql.join(
            candidates.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}))`;
  const [row] = await q.execute<{ boundary: string | null; count: number; ids: Uuid[] }>(sql`
    with m as (
      select ${newBoundary} as boundary from ${threadVisits} as v where v.owner_id = ${viewerId}::uuid and v.post_id = ${postId}::uuid
    )
    select
      to_char(m.boundary at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as boundary,
      (select count(*)::int from ${comments} as c where c.post_id = ${postId}::uuid and c.created_at > m.boundary and ${newTo(viewerId)}) as count,
      ${onPage} as ids
    from m`);
  // No marker: the viewer has not opened this thread yet, and nothing is new.
  if (!row || row.boundary === null) return firstVisit;
  return { previousVisitAt: row.boundary, newCount: row.count, newIds: new Set(row.ids) };
}

/**
 * Records that the principal opened the thread of `postId` now. `recorded` is false within a
 * visit already recorded (a reload, a return a few minutes later), which writes and emits
 * nothing. Called only by web's POST from a page on screen: never by a prefetch, a HEAD or a
 * visitor without a session.
 */
export async function recordVisitAs(principal: Principal, input: { postId: Uuid }): Promise<Result<{ recorded: boolean }>> {
  const decision = await authorize('visit.record', principal, { postId: input.postId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => recordVisit(decision.grant, undefined));
}
