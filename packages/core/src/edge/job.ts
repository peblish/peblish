import { defineJob } from '../outbox/jobs.ts';
import { edgeConfig } from './config.ts';
import { flushPurges } from './send.ts';

// Pays the edge purge debt (send.ts). Every worker runs it every 5 s; the claim spaces requests
// SEND_GAP_MS apart across all of them, so any number of workers stays at 4 requests a minute,
// under the free plan's 5 (account-wide, burst 25). Without the purge configuration it does
// nothing, and web answers private because no readiness record is fresh.
export const job = defineJob({
  name: 'edge.purge_flush',
  everyMs: 5_000,
  run: async () => {
    const config = edgeConfig();
    if (config) await flushPurges(config);
  },
});
