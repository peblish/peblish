import { defineJob } from '../outbox/jobs.ts';
import { retryUnansweredFollows } from './resend.ts';

// Sends unanswered Follows again (retry.ts has the rule). Every worker runs it; the mutation
// repeats the due check under the row lock, so two workers send one.
export const job = defineJob({
  name: 'follows.retry',
  everyMs: 30_000,
  run: async () => {
    await retryUnansweredFollows();
  },
});
