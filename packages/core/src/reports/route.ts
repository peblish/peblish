import { and, isNotNull } from 'drizzle-orm';
import { openGroup } from '../authz/actions/reports.ts';
import { reports } from '../db/tables/moderation.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

/**
 * Escalates a moderators' group to the admins, or sends an escalated one back. Sending back
 * moves only the rows a moderator escalated: an admins-only category never reaches moderators,
 * even when it shares a target with an escalated report. Rechecked like resolveReports, so the
 * authority to move a group is the one in force when it moves.
 */
export const routeReports = defineMutation({
  action: 'report.route',
  emits: ['report.routed'],
  recheck: true,
  async run(t, grant, _input: Record<string, never>) {
    const { target, audience, to } = grant.subject;
    const escalating = to === 'admins';
    const rows = await t.db
      .update(reports)
      .set(
        escalating
          ? { audience: to, escalatedBy: grant.actorId, escalatedAt: new Date() }
          : { audience: to, escalatedBy: null, escalatedAt: null },
      )
      .where(escalating ? openGroup(target, audience) : and(openGroup(target, audience), isNotNull(reports.escalatedAt)))
      .returning({ id: reports.id, communityId: reports.communityId });
    if (rows.length === 0) throw new Refused('report.route', 'report.not_open');
    await t.emit({
      type: 'report.routed',
      v: 1,
      target,
      communityId: rows[0]!.communityId,
      to,
      by: grant.actorId,
      reportIds: rows.map((row) => row.id),
    });
    return { count: rows.length };
  },
});
