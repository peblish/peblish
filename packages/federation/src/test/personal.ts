import { db } from '@peblish/core/db/read';
import { activities } from '@peblish/core/db/tables/federation';
import { outbox, outboxCursors } from '@peblish/core/db/tables/outbox';
import { deliveries } from '@peblish/core/delivery/tables';
import { ensureCursors, processBatch } from '@peblish/core/outbox/worker';
import { count, inArray, sql } from 'drizzle-orm';
import { federationConsumers } from '../registry/consumers.gen.ts';

// Test support for the personal features (saves, pins, thread follows, visits): each feature's
// test emits its events through its real mutation, then asserts with drainFederation that no
// federation consumer turned them into anything another server would receive.

/** What the federation consumers added while draining: activities stored, deliveries queued, events they emitted. */
export type FederationOutput = { activities: number; deliveries: number; emitted: number };

async function tally() {
  const [stored] = await db().select({ n: count() }).from(activities);
  const [queued] = await db().select({ n: count() }).from(deliveries);
  const [events] = await db().select({ n: count() }).from(outbox);
  return { activities: stored?.n ?? 0, deliveries: queued?.n ?? 0, events: events?.n ?? 0 };
}

async function waiting(): Promise<number> {
  const names = federationConsumers.map(({ name }) => name);
  const [row] = await db()
    .select({ n: count() })
    .from(outbox)
    .innerJoin(outboxCursors, inArray(outboxCursors.consumer, names))
    .where(sql`(${outbox.txId}, ${outbox.id}) > (${outboxCursors.txId}, ${outboxCursors.eventId})`);
  return row?.n ?? 0;
}

/**
 * Runs every federation consumer (the generated registry, so one added later is covered too)
 * through the worker's real batch until each cursor has passed every outbox row, and returns
 * what they added meanwhile. The horizon is the oldest transaction on the whole server, so on a
 * busy machine a batch can move nothing for a while: this waits for the cursors, up to 90 s.
 * Drain once after seeding, so the deltas count only what the events under test caused.
 */
export async function drainFederation(): Promise<FederationOutput> {
  await ensureCursors(federationConsumers);
  const before = await tally();
  const deadline = Date.now() + 90_000;
  for (;;) {
    for (const consumer of federationConsumers) await processBatch(consumer);
    if ((await waiting()) === 0) break;
    if (Date.now() > deadline) throw new Error('the federation consumers did not catch up');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = await tally();
  return {
    activities: after.activities - before.activities,
    deliveries: after.deliveries - before.deliveries,
    emitted: after.events - before.events,
  };
}
