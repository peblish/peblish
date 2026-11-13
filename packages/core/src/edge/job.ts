import { defineJob } from '../outbox/jobs.ts';
import { edgeConfig } from './config.ts';
import { purgeQueue } from './queue.ts';

// Sends the purges the edge.purge consumer owes, one request a run at most. Every 20 s keeps a
// worker at 3 requests a minute, under the free plan's 5 a minute for tag purges (shared by the
// account, burst 25), and leaves a taken-down image at the edge for about 20 s after its event.
// The first run of a new worker sends the wide purge its queue starts with (queue.ts).
export const job = defineJob({
  name: 'edge.purge_flush',
  everyMs: 20_000,
  run: async () => {
    const config = edgeConfig();
    if (config) await purgeQueue().flush(config);
  },
});
