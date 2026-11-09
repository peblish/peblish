import { defineJob } from '../outbox/jobs.ts';
import { purgePass } from './purge.ts';

// Every minute, on every worker: end undecided quarantines, delete the bytes of blocked and failed
// images, expire old manifests (purge.ts). Safe to run twice at once: each step is a mutation that
// locks the media row and repeats its own check, and deleting a missing object succeeds.
export const job = defineJob({
  name: 'evidence.purge',
  everyMs: 60_000,
  run: async (signal) => {
    await purgePass({ signal });
  },
});
