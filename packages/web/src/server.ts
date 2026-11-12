// First: every console method in the web process goes through the log boundary.
import './server/log-boundary-install.ts';
import { createServerEntry, createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { getRouter } from './router.tsx';
import { withClientAborts } from './server/client-gone.ts';
import { withRequestEndpoint } from './server/endpoint.ts';
import { withFederation } from './server/federation.ts';
import { withSecurityHeaders } from './server/headers.ts';

// The server entry (TanStack Start picks up src/server.ts): federation first, then the UI;
// HTML responses get the security baseline. The handler is built here rather than taken from
// `@tanstack/react-start/server-entry`, whose default export already wraps it in Start's logging
// catch: withClientAborts must see an error first, so a client that left mid-request is not
// logged while every other error still reaches that catch (createServerEntry) and its log line.
// Outside it all, each request runs with its endpoint (method and route template) known to the
// log boundary, so every line it logs, Start's included, names the page without its path.
const entry = createServerEntry({
  fetch: withClientAborts(withSecurityHeaders(withFederation(createStartHandler(defaultStreamHandler)))),
});

/** The router, for matching a path to its route template only. */
const router = getRouter();
const routeOf = (pathname: string) => router.getMatchedRoutes(pathname)[2]?.id ?? null;

export default { fetch: withRequestEndpoint(entry.fetch, routeOf) };
