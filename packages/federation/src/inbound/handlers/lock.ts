import type { Activity } from '../../mapping/records.ts';
import type { InboundHandler } from '../handler.ts';
import { prepareLock } from './_lock.ts';

export const handler: InboundHandler = {
  type: 'Lock',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Lock') throw new TypeError('the Lock handler was given another activity');
    return prepareLock(ctx, activity.objectApId, true);
  },
  async undo(ctx, undone: Activity) {
    if (undone.type !== 'Lock') throw new TypeError('the Lock handler was asked to undo another activity');
    return prepareLock(ctx, undone.objectApId, false);
  },
};
