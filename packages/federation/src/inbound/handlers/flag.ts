import { db } from '@peblish/core/db/read';
import { authorizeReport } from '../authorize.ts';
import type { InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// Flag, the federated report. Lane REP owns this file from wave 3 and replaces the last line
// with the reports flow (`reports.category` is NOT NULL and a Flag has no category, so REP picks
// a default). Until then a Flag is read, checked to be about content stored here in a community
// hosted here (authorizeReport, the spike's N8), and recorded as not handled.
export const handler: InboundHandler = {
  type: 'Flag',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Flag') throw new TypeError('the Flag handler was given another activity');
    await authorizeReport(db(), [activity.report.targetApId]);
    throw skip('flag.not_handled', activity.id);
  },
};
