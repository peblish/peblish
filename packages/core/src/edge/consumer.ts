import { defineConsumer } from '../outbox/consumers.ts';
import { owePurgeOfEverything, owePurges } from './debt.ts';
import { CONSUMER_NAME } from './ready.ts';
import { purgeFor, takedownEvents } from './takedowns.ts';

// Finds the takedowns the edge must forget (takedowns.ts) and owes their purges in the batch
// transaction that also moves this consumer's cursor (debt.ts), so a takedown is never consumed
// without its debt being written, whichever worker runs it. It makes no request: the
// edge.purge_flush job pays the debt (send.ts). It owes even without the purge configuration
// (the debt is bounded, debt.ts), so configuring it later forgets nothing taken down meanwhile.
// An event the worker skips past (it kept failing, or a mutation refused it) never owes its own
// purge, so it owes a purge of everything, late at once, in the transaction that moves the
// cursor: web answers private until that is sent, and nothing it would have purged stays.
export const consumer = defineConsumer({
  name: CONSUMER_NAME,
  events: takedownEvents,
  startAt: 'now',
  handle: async (event, t) => {
    const purge = await purgeFor(event, t.db);
    if (purge) await owePurges(t.db, purge);
  },
  skipped: (_event, t) => owePurgeOfEverything(t.db),
});
