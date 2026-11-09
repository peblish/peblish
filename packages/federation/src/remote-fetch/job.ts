import { defineJob } from '@peblish/core/outbox/jobs';
import { fetchMissing } from './missing.ts';

// Fetches the objects that skipped activities are waiting for (missing.ts). Every worker may
// run it: storing an object twice is `created: false`, and the requeue is idempotent.
export const job = defineJob({
  name: 'federation.missing_objects',
  everyMs: 60_000,
  run: async (signal) => {
    await fetchMissing({ signal });
  },
});
