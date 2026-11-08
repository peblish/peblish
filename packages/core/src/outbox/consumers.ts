import type { EventType, OutboxEvent } from '@peblish/schema/events';
import type { OpenTx } from '../tx/tx.ts';

/**
 * What a consumer's handler sees: the batch transaction, which also advances its cursor. emit
 * queues a follow-up event of a type the consumer declared in `emits`, in that same
 * transaction, and mutation.within(t, grant, input) runs a mutation in it (its events go
 * through the same emit), so a chained effect commits with the cursor or not at all.
 *
 * A mutation that refuses (Refused, from its recheck) is permanent for that event: the worker
 * rolls back that event's handler to a savepoint, logs it at error level with the consumer
 * and the outbox id, counts it in outbox_cursors.refused and moves on. Retrying would stall
 * the consumer behind it forever. Any other error rolls back the batch and is retried.
 */
export type ConsumerTx = OpenTx;

/**
 * Where a consumer's cursor starts the first time the worker sees its name.
 * - 'beginning': every event still in the outbox.
 * - 'now': the safe horizon, the oldest transaction still running. Events of transactions
 *   older than that are not delivered; every event of a transaction that is still in flight
 *   or starts later is, including some that commit before the cursor is created. Nothing
 *   after the horizon is skipped.
 */
export type ConsumerStart = 'beginning' | 'now';

/**
 * An outbox consumer, registered by glob: any file named consumer.ts under
 * packages/core/src or packages/federation/src that exports `consumer`. Handlers run inside
 * the batch transaction, so database effects and the cursor commit together (effectively
 * once); keep them short and put slow side effects (HTTP delivery) in their own job rows.
 */
export interface Consumer {
  /** Stable and unique; it keys the cursor row, so renaming restarts the consumer at startAt. */
  readonly name: string;
  readonly events: readonly EventType[];
  /**
   * The event types its handler may emit. The worker refuses to start a consumer that emits a
   * type it consumes (it would feed itself forever); a cycle through other consumers is the
   * authors' to avoid.
   */
  readonly emits: readonly EventType[];
  readonly startAt: ConsumerStart;
  handle(event: OutboxEvent, t: ConsumerTx): Promise<void>;
}

function isOneOf<E extends EventType>(event: OutboxEvent, types: readonly E[]): event is Extract<OutboxEvent, { type: E }> {
  return types.some((type) => type === event.type);
}

export function defineConsumer<E extends EventType>(spec: {
  name: string;
  events: readonly [E, ...E[]];
  /** What the handler (or a mutation it runs) may emit; none when omitted. */
  emits?: readonly EventType[];
  startAt: ConsumerStart;
  handle(event: Extract<OutboxEvent, { type: E }>, t: ConsumerTx): Promise<void>;
}): Consumer {
  return {
    name: spec.name,
    events: spec.events,
    emits: spec.emits ?? [],
    startAt: spec.startAt,
    handle: async (event, t) => {
      if (isOneOf(event, spec.events)) await spec.handle(event, t);
    },
  };
}

/**
 * Throws, before the worker starts, when two consumers share a name (they would share one
 * cursor and skip each other's events) or one emits a type it consumes (it would loop).
 */
export function assertRunnable(consumers: readonly Consumer[]): void {
  const seen = new Set<string>();
  for (const { name, events, emits } of consumers) {
    if (seen.has(name)) throw new Error(`two outbox consumers are named ${name}; each name keys its own cursor`);
    seen.add(name);
    const loop = emits.find((type) => events.includes(type));
    if (loop) throw new Error(`outbox consumer ${name} emits ${loop}, which it also consumes, so it would feed itself forever`);
  }
}
