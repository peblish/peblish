import { defineJob } from '@peblish/core/outbox/jobs';
import { deliverDue } from './run.ts';

// The delivery queue's worker. It polls: a row written by a consumer goes out within a few
// seconds. Every worker runs it; rows are claimed with SKIP LOCKED (run.ts).
export const job = defineJob({
  name: 'federation.delivery_queue',
  everyMs: 2_000,
  run: async (signal) => {
    await deliverDue({ signal });
  },
});
