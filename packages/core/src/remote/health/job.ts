import { defineJob } from '../../outbox/jobs.ts';
import { evaluateInstanceHealth } from '../dormant.ts';

// Marks instances dormant and revives them (remote/dormant.ts has the policy). Every worker may
// run it: both writes are idempotent, so two runs agree.
export const job = defineJob({
  name: 'remote.instance_health',
  everyMs: 10 * 60_000,
  run: async () => {
    await evaluateInstanceHealth();
  },
});
