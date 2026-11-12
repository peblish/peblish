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
  const method = /^[A-Z]{1,10}$/.test(request.method) ? request.method : 'OTHER';
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/_serverFn/')) return `${method} server function`;
  return `${method} ${routeOf(pathname) ?? '(no route)'}`;
}

/** Runs each request with its endpoint known to the log boundary (server/log-boundary.ts) and to core's onRequestPath. */
export function withRequestEndpoint<O>(next: Fetch<O>, routeOf: RouteOf) {
  return (request: Request, opts?: O) => requestScope.run(endpointOf(request, routeOf), () => next(request, opts));
}
