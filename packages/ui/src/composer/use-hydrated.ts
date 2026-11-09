import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * False on the server and while the page hydrates, true once it has: the controls that need
 * JavaScript stay disabled until then. (React's own answer to "am I on the client yet", with no
 * effect and no second render of its own.)
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
