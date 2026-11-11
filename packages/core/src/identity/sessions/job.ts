import { defineJob } from '../../outbox/jobs.ts';
import { sweepExpiredSessions } from './sweep.ts';

// Deletes expired sessions in bounded batches (sweep.ts); safe with two workers at once.
export const job = defineJob({
  name: 'identity.session_sweep',
  everyMs: 60 * 60_000,
  run: async (signal) => {
    await sweepExpiredSessions({ signal });
  },
});
