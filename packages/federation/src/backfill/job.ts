import { defineJob } from '@peblish/core/outbox/jobs';
import { backfillDue } from './run.ts';

// Runs the queued backfills, a few at a time (run.ts has the rules). Every worker may run it:
// a backfill is claimed under a lease, so two workers never run the same community.
export const job = defineJob({
  name: 'federation.backfill_run',
  everyMs: 30_000,
  run: async (signal) => {
    await backfillDue({ signal });
  },
});
