/**
 * A bound on work done at once: up to `limit` holders, up to `queue` more waiting in order, and
 * a refusal beyond that. Nothing is shared between processes.
 */
export function createSlots(limit: number, queue: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    /**
     * Resolves with a function that gives the slot back (call it once, in a `finally`), after
     * waiting for a free slot if need be; resolves with null at once when the queue is full too.
     */
    async acquire(): Promise<(() => void) | null> {
      if (running < limit) {
        running++;
      } else if (waiting.length < queue) {
        // A releasing holder hands its slot straight to the first waiter, so `running` stays put.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        return null;
      }
      return () => {
        const next = waiting.shift();
        if (next) next();
        else running--;
      };
    },
  };
}

export type Slots = ReturnType<typeof createSlots>;
