import type { Activity } from '../../mapping/records.ts';
import type { InboundHandler } from '../handler.ts';
import { prepareBan } from './_ban.ts';

export const handler: InboundHandler = {
  type: 'Block',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Block') throw new TypeError('the Block handler was given another activity');
    return prepareBan(ctx, activity, true);
  },
  async undo(ctx, undone: Activity) {
    if (undone.type !== 'Block') throw new TypeError('the Block handler was asked to undo another activity');
    return prepareBan(ctx, undone, false);
  },
};
