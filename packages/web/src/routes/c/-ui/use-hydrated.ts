import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/** False on the server and while the page hydrates, true after: the controls that need JavaScript stay disabled until then. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
