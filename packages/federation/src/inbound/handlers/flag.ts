import { db } from '@peblish/core/db/read';
import { createReport, detailsLimit } from '@peblish/core/reports/create';
import { authorizeReport, checkAuthorIsPerson, checkCommunity, communityById, grantFor, storedActor, storedContent } from '../authorize.ts';
import { prepared, type InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// Flag, the federated report. A peer reports content in a community hosted here (Lemmy and
// PieFed send the Flag to the community, `summary` or `content` holding the reason), or a
// person of ours (Mastodon names the person first among the objects). The report is filed as
// the category `other` with the reason as its details: peers send no category. Content reports
// go to the community's moderators and the admins, person reports to the admins alone. Nothing
// is relayed: a Flag is for the moderators of the instance it is sent to. The policy
// (authz/actions/reports.ts) skips a removed or deleted target, a banned reporter and a
// reporter's second open report.
const noReason = '(no reason given)';

export const handler: InboundHandler = {
  type: 'Flag',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Flag') throw new TypeError('the Flag handler was given another activity');
    checkAuthorIsPerson(ctx);
    const { targetApId, reason } = activity.report;
    const details = (reason?.trim() || noReason).slice(0, detailsLimit);
    const stored = await storedContent(db(), targetApId);
    if (stored) {
      // Reports count only about content in a community hosted here (the spike's N8).
      await authorizeReport(db(), [targetApId]);
      const community = await communityById(db(), stored.communityId);
      checkCommunity(ctx, community, activity.communityApId);
      return prepared(ctx, async (t) => {
        const grant = await grantFor(ctx, t, 'report.create', {
          target: { kind: stored.kind, id: stored.id },
          category: 'other',
          forward: false,
        });
        await createReport.within(t, grant, { details, apId: activity.id, raw: ctx.raw });
        return { communityId: community.id, objectApId: stored.apId };
      });
    }
    const person = await storedActor(db(), targetApId);
    if (!person?.local || person.kind !== 'Person') throw skip('report.not_local', targetApId);
    return prepared(ctx, async (t) => {
      const grant = await grantFor(ctx, t, 'report.create', {
        target: { kind: 'actor', id: person.id },
        category: 'other',
        forward: false,
      });
      await createReport.within(t, grant, { details, apId: activity.id, raw: ctx.raw });
      return { objectApId: person.apId };
    });
  },
};
