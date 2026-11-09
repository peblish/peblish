import { defineJob } from '@peblish/core/outbox/jobs';
import { recheckObjects } from '../recheck.ts';

// Asks after the held remote posts and comments that are due (recheck.ts). Every worker may run
// it: the objects a run takes are marked as taken, so two runs take different ones.
export const job = defineJob({
  name: 'federation.recheck_objects',
  everyMs: 10 * 60_000,
  run: async (signal) => {
    await recheckObjects({ signal });
  },
});
