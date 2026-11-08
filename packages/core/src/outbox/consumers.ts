import type { EventType, OutboxEvent } from '@peblish/schema/events';
import type { WriteTx } from '../db/write.ts';

/** What a consumer's handler sees: the batch transaction, which also advances its cursor. */
export type ConsumerTx = { readonly db: WriteTx };

/**
 * An outbox consumer, registered by glob: any file named consumer.ts under packages/core/src
 * that exports `consumer`. Handlers run inside the batch transaction, so database effects and the cursor
 * commit together (effectively once); keep them short and put slow side effects (HTTP
 * delivery) in their own job rows.
 */
export interface Consumer {
  /** Stable name; it keys the cursor row, so renaming restarts the consumer at "now". */
  readonly name: string;
  readonly events: readonly EventType[];
  handle(event: OutboxEvent, t: ConsumerTx): Promise<void>;
}

function isOneOf<E extends EventType>(event: OutboxEvent, types: readonly E[]): event is Extract<OutboxEvent, { type: E }> {
  return types.some((type) => type === event.type);
}

export function defineConsumer<E extends EventType>(spec: {
  name: string;
  events: readonly [E, ...E[]];
  handle(event: Extract<OutboxEvent, { type: E }>, t: ConsumerTx): Promise<void>;
}): Consumer {
  return {
    name: spec.name,
    events: spec.events,
    handle: async (event, t) => {
      if (isOneOf(event, spec.events)) await spec.handle(event, t);
    },
  };
}
