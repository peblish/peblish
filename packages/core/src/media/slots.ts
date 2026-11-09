/**
 * A bound on work done at once: up to `limit` holders, up to `queue` more waiting in order, and
 * a refusal beyond that. A waiter whose signal fires leaves the queue. Nothing is shared between
 * processes.
 */
export function createSlots(limit: number, queue: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    /**
     * Resolves with a function that gives the slot back (call it once, in a `finally`), after
     * waiting for a free slot if need be; resolves with null at once when the queue is full too,
     * and when `signal` fires first (nobody is left to answer), freeing the queue place.
     */
    async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
      if (signal?.aborted) return null;
      if (running < limit) {
        running++;
      } else if (waiting.length < queue) {
        // A releasing holder hands its slot straight to the first waiter, so `running` stays put.
        const turn = await new Promise<boolean>((resolve) => {
          const grant = () => {
            signal?.removeEventListener('abort', leave);
            resolve(true);
          };
          const leave = () => {
            waiting.splice(waiting.indexOf(grant), 1);
            resolve(false);
          };
          waiting.push(grant);
          signal?.addEventListener('abort', leave, { once: true });
        });
        if (!turn) return null;
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
