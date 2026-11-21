import { useCallback, useSyncExternalStore } from 'react';

// The comments a reader folded or opened during this visit, by comment id (Commons keeps folds for the
// visit, in the browser): a map in this module, so leaving for another page and coming Back finds them
// again, and a reload starts over. Only event handlers write it. The server's copy therefore stays empty,
// so no request sees another reader's folds, and a document's first render (and its hydration) never
// depends on it.

const folds = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

/** Records the reader's fold of comment `id` and re-renders the rows showing it. */
export function setFold(id: string, folded: boolean): void {
  folds.set(id, folded);
  for (const listener of listeners.get(id) ?? []) listener();
}

const nothing = () => () => undefined;

/**
 * The reader's own fold of comment `id` this visit, or undefined when they have not touched it (or `id` is
 * null). Only the rows of that comment re-render when it changes.
 */
export function useFold(id: string | null): boolean | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (id === null) return () => undefined;
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      };
    },
    [id],
  );
  return useSyncExternalStore(
    id === null ? nothing : subscribe,
    () => (id === null ? undefined : folds.get(id)),
    () => undefined,
  );
}
