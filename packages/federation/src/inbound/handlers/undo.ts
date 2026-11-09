import { checkActivityOrigin, checkUndoActor } from '../authorize.ts';
import type { InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// Undo reverses an activity of the same actor; the handler of the undone type knows how
// (handler.undo). The outer actor is the inner one (a Lemmy Undo(Like) carries a fresh Like id,
// so nothing is matched by it), and both are on their actor's origin.
export const handler: InboundHandler = {
  type: 'Undo',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Undo') throw new TypeError('the Undo handler was given another activity');
    const undone = activity.object;
    checkUndoActor(activity, undone);
    checkActivityOrigin(undone);
    const handler = ctx.handlerFor(undone.type);
    if (!handler?.undo) throw skip('undo.unsupported', undone.type);
    return handler.undo(ctx, undone);
  },
};
