import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { parseEvent, type OutboxEvent } from '@peblish/schema/events';
import { inboxDedupe } from '../db/tables/federation.ts';
import { outbox } from '../db/tables/outbox.ts';
import { writer, type WriteTx } from '../db/write.ts';

/** NOTIFY channel the outbox worker listens on; notifications are delivered at commit. */
export const OUTBOX_CHANNEL = 'peblish_outbox';

/**
 * A write transaction. The state change, its outbox rows (emit) and its dedupe marker
 * (dedupe) commit together or not at all. Only mutations (mutation.ts), the outbox worker
 * and the inbound federation pipeline may open one (lint rule core-tx-access).
 */
export interface Tx {
  readonly db: WriteTx;
  /** Queues `event` in the outbox, validated against the event union. */
  emit(event: OutboxEvent): Promise<void>;
  /**
   * Records the dedupe marker for an inbound activity. Returns false when it was already
   * applied (by this or a concurrent transaction): skip the change then. Pass the applied
   * activity's id: the inner activity's when it arrived inside an Announce, so a direct and
   * an announced copy apply once.
   */
  dedupe(activityId: string): Promise<boolean>;
}

const openTransaction = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as the body of an open write transaction, so a tx() started from inside it
 * (say a mutation's call signature in another mutation's body or a consumer) fails fast
 * instead of taking a second pool connection and possibly deadlocking the pool.
 */
export function insideTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return openTransaction.run(true, fn);
}

export async function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  if (openTransaction.getStore()) {
    throw new Error('tx() inside an open transaction: call the inner mutation with mutation.within(t, grant, input) instead');
  }
  return writer().transaction(async (db) =>
    insideTransaction(async () => {
      let emitted = false;
      const t: Tx = {
        db,
        async emit(event) {
          const valid = parseEvent(event);
          await db.insert(outbox).values({ type: valid.type, v: valid.v, payload: valid });
          emitted = true;
        },
        async dedupe(activityId) {
          const inserted = await db
            .insert(inboxDedupe)
            .values({ activityId })
            .onConflictDoNothing()
            .returning({ activityId: inboxDedupe.activityId });
          return inserted.length > 0;
        },
      };
      const result = await fn(t);
      if (emitted) await db.execute(sql`select pg_notify(${OUTBOX_CHANNEL}, '')`);
      return result;
    }),
  );
}
