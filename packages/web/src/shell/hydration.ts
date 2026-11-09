import { useEffect } from 'react';

/**
 * Sets html[data-hydrated] once the calling route's content has hydrated. Call it from route
 * content, never the root: TanStack Router wraps the root Outlet's child in a Suspense
 * boundary that React hydrates after the shell, so a root effect fires before the page is
 * interactive (mux-start spike F2). e2e waits for this marker (e2e/support/route-marker.ts).
 */
export function useRouteHydrated(): void {
  useEffect(() => {
    document.documentElement.dataset.hydrated = '1';
  }, []);
}
