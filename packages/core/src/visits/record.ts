import { sql } from 'drizzle-orm';
import { defineMutation } from '../tx/mutation.ts';
import { threadVisits } from './tables.ts';

// The one write of "new since last visit" (visits.ts has the rules). One upsert, so two tabs
// recording at once cannot both rotate the marker or move it back.

/** How long a visit lasts, from its start: returning or reloading within it is the same visit (visits.ts). */
export const visitWindow = sql`interval '30 minutes'`;

/**
 * Writes the visit: a first one inserts the baseline; once the window since the marker's visit
 * has passed it rotates last_visit_at into previous_visit_at. Within the window it is the same
 * visit, so it writes and emits nothing (a reload, another sort, a return a few minutes later):
 * the window counts from the visit's start, so a reader who keeps coming back still gets a new
 * visit every window.
 */
export const recordVisit = defineMutation({
  action: 'visit.record',
  emits: ['visit.recorded'],
  recheck: true,
  async run(t, grant) {
    const ownerId = grant.principal.actorId;
    const { postId } = grant.subject;
    const rows = await t.db
      .insert(threadVisits)
      .values({ ownerId, postId, lastVisitAt: sql`now()`, previousVisitAt: null })
      .onConflictDoUpdate({
        target: [threadVisits.ownerId, threadVisits.postId],
        set: { previousVisitAt: sql`${threadVisits.lastVisitAt}`, lastVisitAt: sql`now()` },
        setWhere: sql`${threadVisits.lastVisitAt} <= now() - ${visitWindow}`,
      })
      .returning({ ownerId: threadVisits.ownerId });
    if (rows.length === 0) return { recorded: false };
    await t.emit({ type: 'visit.recorded', v: 1, ownerId, postId });
    return { recorded: true };
  },
});
