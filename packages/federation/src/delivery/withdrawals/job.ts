import { defineJob } from '@peblish/core/outbox/jobs';
import { withdrawRemaining } from '../withdraw.ts';

// What a site ban with removeContent leaves to withdraw after its event's first batch
// (withdraw.ts withdrawRemaining). Every worker runs it; an advisory lock per banned person keeps
// two transactions from withdrawing the same posts.
export const job = defineJob({
  name: 'federation.boost_withdrawals',
  everyMs: 60_000,
  run: async (signal) => {
    await withdrawRemaining({ signal });
  },
});
