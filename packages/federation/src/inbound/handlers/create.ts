import type { InboundHandler } from '../handler.ts';
import { prepareContent } from './_content.ts';

/** Create of a Page (a post) or a Note (a comment); a microblog Note to a community was rewritten as a Page by classify.ts. */
export const handler: InboundHandler = {
  type: 'Create',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Create') throw new TypeError('the Create handler was given another activity');
    return prepareContent(ctx, activity.object, 'Create');
  },
};
