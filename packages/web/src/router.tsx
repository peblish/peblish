import { createRouter, type AnyRoute } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { PageError } from './shell/error-page.tsx';
import { logRouteFailure } from './shell/route-failure.ts';

/** Routes whose server-side onError already hides the cause (the route objects outlive each request's router). */
const guarded = new WeakSet<AnyRoute>();

/**
 * On the server, a route's failure (loader, beforeLoad, search or params) is logged, without
 * anything the visitor typed (shell/route-failure.ts), and replaced
 * with a bare error before the router stores it: the stored error is serialised into the page
 * for hydration, and its message (a database address, a validation dump) is not for visitors.
 * The page still renders PageError with a 5xx status. Redirects and not-found never reach onError.
 */
function hideServerErrors(routes: readonly AnyRoute[]): void {
  for (const route of routes) {
    if (guarded.has(route)) continue;
    guarded.add(route);
    const own = route.options.onError;
    route.options.onError = (error: unknown) => {
      own?.(error);
      logRouteFailure(route.id, error);
      throw new Error('route failed');
    };
  }
}

export function getRouter() {
  const router = createRouter({ routeTree, scrollRestoration: true, defaultErrorComponent: PageError });
  if (router.isServer) hideServerErrors(Object.values(router.routesById));
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
