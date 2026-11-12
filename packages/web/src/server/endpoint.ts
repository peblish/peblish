import type { Fetch } from './fetch.ts';
import { requestScope } from '@peblish/core/log-scope';

/** The route that serves a path, as the router names it (a template such as "/u/$handle/"), or null when none does. */
export type RouteOf = (pathname: string) => string | null;

/**
 * The endpoint a request is for, safe to log: its method and route template, "server function"
 * for TanStack Start's /_serverFn/<id> calls (the id is whatever the caller sent), or "(no route)".
 * Never the path itself: its parameters are what a visitor typed.
 */
export function endpointOf(request: Request, routeOf: RouteOf): string {
  const method = methodOf(request);
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/_serverFn/')) return `${method} server function`;
  return `${method} ${routeOf(pathname) ?? '(no route)'}`;
}

/** The request's method when it is a plain token, else OTHER: never what an odd request line carried. */
const methodOf = (request: Request) => (/^[A-Z]{1,10}$/.test(request.method) ? request.method : 'OTHER');

/**
 * The outermost wrapper of the Nitro app (server/log-boundary-plugin.ts), around everything h3 does
 * before a route is matched: the request runs in the scope as "<METHOD> (unmatched)" (the SSR entry
 * then narrows it to its route template, withRequestEndpoint), and an error that escapes h3 itself
 * (its event could not even be built, as for a Host the URL parser refuses) is logged here, in that
 * scope and through the boundary, and answered with the empty 500 srvx would send. Reads only the
 * method: the target and Host are what failed.
 */
export function withUnmatchedEndpoint(next: (request: Request) => Response | Promise<Response>) {
  return (request: Request): Promise<Response> =>
    requestScope.run(`${methodOf(request)} (unmatched)`, async () => {
      try {
        return await next(request);
      } catch (error) {
        console.error('request failed before routing:', error);
        return new Response(null, { status: 500 });
      }
    });
}

/** Runs each request with its endpoint known to the log boundary (server/log-boundary.ts) and to core's onRequestPath. */
export function withRequestEndpoint<O>(next: Fetch<O>, routeOf: RouteOf) {
  return (request: Request, opts?: O) => requestScope.run(endpointOf(request, routeOf), () => next(request, opts));
}
