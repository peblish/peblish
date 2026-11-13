import { defineConsumer } from '../outbox/consumers.ts';
import { edgeConfig } from './config.ts';
import { purgeQueue } from './queue.ts';
import { purgeFor, takedownEvents } from './takedowns.ts';

// Finds the takedowns the edge must forget (takedowns.ts) and owes their purges to the queue the
// edge.purge_flush job sends (job.ts). It makes no request itself, so the outbox transaction never
// waits on Cloudflare. Without the purge configuration edge caching is off and there is nothing
// to purge. It starts at 'now': before it first ran, nothing was edge-cached, and a worker that
// starts owes a wide purge anyway (queue.ts).
export const consumer = defineConsumer({
  name: 'edge.purge',
  events: takedownEvents,
  startAt: 'now',
  handle: async (event, t) => {
    if (!edgeConfig()) return;
    const purge = await purgeFor(event, t.db);
    if (purge) purgeQueue().add(purge);
  },
});
