import { defineJob } from '../../outbox/jobs.ts';
import { pruneOld } from '../prune-run.ts';

// Deletes settled inbox and delivery rows, old bookkeeping rows and handled outbox events past
// their retention (remote/prune.ts). Two workers
// deleting the same batch is harmless: the second finds fewer rows.
export const job = defineJob({
  name: 'remote.prune',
  everyMs: 60 * 60_000,
  run: async (signal) => {
    await pruneOld({ signal });
  },
});
