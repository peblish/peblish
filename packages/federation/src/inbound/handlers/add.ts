import type { InboundHandler } from '../handler.ts';
import { prepareCollection } from './_collection.ts';

export const handler: InboundHandler = {
  type: 'Add',
  prepare: (ctx) => prepareCollection(ctx, true),
};
