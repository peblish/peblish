import { sql } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { ensureCursors, processBatch } from '../outbox/worker.ts';
import { consumer } from '../edge/consumer.ts';
import { owedRows } from '../edge/debt.ts';
import { edgePurges } from '../edge/tables.ts';

// For tests that make a takedown through its real writer and then run the edge purge consumer
// through the real outbox worker: the debt it leaves is the proof the takedown reaches the purge.

/** Puts the consumer's cursor at the end of the outbox and clears the debt seeding left. */
export async function startDrain(): Promise<void> {
  await ensureCursors([consumer]);
  await writer().delete(edgePurges);
}

/**
 * Runs the consumer until its cursor has passed every event, then the tags owed, sorted. The
 * horizon is the oldest transaction anywhere on the shared server, so a busy machine can hold a
 * batch back for a while.
 */
export async function owedAfterDrain(): Promise<string[]> {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    await processBatch(consumer);
    const [waiting] = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from outbox o, outbox_cursors c
        where c.consumer = ${consumer.name} and (o.tx_id, o.id) > (c.tx_id, c.event_id)`,
    );
    if (waiting?.n === 0) return (await owedRows(db())).map((row) => row.tag).toSorted();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the edge purge consumer did not catch up');
}
