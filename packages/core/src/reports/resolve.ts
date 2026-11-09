import { type } from 'arktype';
import { openGroup } from '../authz/actions/reports.ts';
import { reports } from '../db/tables/moderation.ts';
import { Uuid } from '@peblish/schema/ids';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { detailsLimit } from './create.ts';

export const ResolveInput = type({
  resolution: "'resolved' | 'dismissed' | 'removed'",
  'note?': 'string | null',
  /** The modlog row of the removal, for the resolution `removed`. */
  'modlogId?': Uuid.or('null'),
});
export type ResolveInput = typeof ResolveInput.infer;

/**
 * Closes every open report of a group in one statement: who, when, how and the note stay on
 * the rows (no modlog row of its own; a removal's modlog row is the removal's). The update
 * matches only rows still open, so two people resolving the same group cannot both succeed.
 * The recheck reads the acting person, the community row (FOR NO KEY UPDATE) and the moderator
 * row (FOR SHARE) inside the transaction, never from the moderator cache, so a demotion or a
 * site ban that landed after authorize() refuses the write, and one in flight waits for it.
 */
export const resolveReports = defineMutation({
  action: 'report.resolve',
  emits: ['report.resolved'],
  recheck: true,
  async run(t, grant, raw: ResolveInput) {
    const input = ResolveInput.assert(raw);
    const { target, audience } = grant.subject;
    const note = input.note?.trim() || null;
    if (note !== null && note.length > detailsLimit) throw new Refused('report.resolve', 'report.reason_required');
    if (input.resolution === 'removed' && target.kind === 'actor') throw new Refused('report.resolve', 'report.not_content');
    const rows = await t.db
      .update(reports)
      .set({
        status: input.resolution === 'dismissed' ? 'dismissed' : 'resolved',
        resolution: input.resolution,
        resolvedBy: grant.actorId,
        resolvedAt: new Date(),
        resolutionNote: note,
        modlogId: input.modlogId ?? null,
      })
      .where(openGroup(target, audience))
      .returning({ id: reports.id, number: reports.number, reporterId: reports.reporterId, communityId: reports.communityId });
    if (rows.length === 0) throw new Refused('report.resolve', 'report.not_open');
    await t.emit({
      type: 'report.resolved',
      v: 1,
      target,
      communityId: rows[0]!.communityId,
      audience,
      resolution: input.resolution,
      resolvedBy: grant.actorId,
      modlogId: input.modlogId ?? null,
      reports: rows.map(({ id, number, reporterId }) => ({ id, number, reporterId })),
    });
    return { count: rows.length };
  },
});
