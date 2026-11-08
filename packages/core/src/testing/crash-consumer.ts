// Child process for the worker crash test (outbox/worker.test.ts): runs one batch whose
// handler writes a dedupe marker, then dies with SIGKILL before the batch commits.
// argv: consumerName
import { writeSync } from 'node:fs';
import { inboxDedupe } from '../db/tables/federation.ts';
import { defineConsumer } from '../outbox/consumers.ts';
import { processBatch } from '../outbox/worker.ts';

const [name] = process.argv.slice(2);
if (!name) throw new Error('usage: crash-consumer consumerName');

await processBatch(
  defineConsumer({
    name,
    events: ['post.created'],
    startAt: 'beginning',
    async handle(event, t) {
      await t.db.insert(inboxDedupe).values({ activityId: `consumed:${event.postId}` });
      // The write has returned inside the open batch; say so synchronously, then die.
      writeSync(1, 'written\n');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    },
  }),
);
