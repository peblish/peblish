/**
 * Calls `save` with the newest value, one call at a time: a value set while a save is running
 * waits, and only the newest waiting value is sent when it ends. Saves therefore reach the
 * server in order, and each carries the whole value rather than a change to merge. A failed
 * save is ignored; the next value is sent as usual.
 */
export function latestSaver<T>(save: (value: T) => Promise<unknown>): (value: T) => void {
  let waiting: { value: T } | null = null;
  let running = false;

  async function run() {
    running = true;
    while (waiting) {
      const { value } = waiting;
      waiting = null;
      await save(value).catch(() => undefined);
    }
    running = false;
  }

  return (value) => {
    waiting = { value };
    if (!running) void run();
  };
}
