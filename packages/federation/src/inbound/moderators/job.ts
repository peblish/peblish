import { defineJob } from '@peblish/core/outbox/jobs';
import { mirrorDue } from './refresh.ts';

// Keeps the mirrored moderators of followed remote communities fresh: a community with no
// mirrored row yet, or one that runs out within two hours, is refetched (core/remote/moderators.ts
// holds the 12 hour lifetime). Every worker may run it; a mirror is a replace, so two runs agree.
export const job = defineJob({
  name: 'federation.moderators',
  everyMs: 15 * 60_000,
  run: async (signal) => {
    await mirrorDue({ signal });
  },
});
