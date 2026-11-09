import type { Activity } from '../../mapping/records.ts';
import type { InboundHandler } from '../handler.ts';
import { prepareVote } from './_vote.ts';

export const handler: InboundHandler = {
  type: 'Like',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Like') throw new TypeError('the Like handler was given another activity');
    const { vote } = activity;
    return prepareVote(ctx, vote.targetApId, { value: 1, apId: vote.apId, raw: vote.raw });
  },
  async undo(ctx, undone: Activity) {
    if (undone.type !== 'Like') throw new TypeError('the Like handler was asked to undo another activity');
    return prepareVote(ctx, undone.vote.targetApId, { value: 0 });
  },
};
