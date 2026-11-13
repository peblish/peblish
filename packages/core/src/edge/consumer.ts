import { defineConsumer } from '../outbox/consumers.ts';
import { owePurges } from './debt.ts';
import { purgeFor, takedownEvents } from './takedowns.ts';

// Finds the takedowns the edge must forget (takedowns.ts) and owes their purges in the batch
// transaction that also moves this consumer's cursor (debt.ts), so a takedown is never consumed
// without its debt being written, whichever worker runs it. It makes no request: the
// edge.purge_flush job pays the debt (send.ts). It owes even without the purge configuration
// (the debt is bounded, debt.ts), so configuring it later forgets nothing taken down meanwhile.
export const consumer = defineConsumer({
  name: 'edge.purge',
  events: takedownEvents,
  startAt: 'now',
  handle: async (event, t) => {
    const purge = await purgeFor(event, t.db);
    if (purge) await owePurges(t.db, purge);
  },
});
