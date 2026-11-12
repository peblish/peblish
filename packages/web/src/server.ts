// First: every console method in the web process goes through the log boundary.
import './server/log-boundary-install.ts';
import { createServerEntry, createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { getServerFnById } from '#tanstack-start-server-fn-resolver';
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

/**
 * A server function's registered name, from the build's own registry (TanStack Start's resolver,
 * which looks the id up exactly and throws for one it does not know): its metadata's name, or
 * null. Resolving loads the function's module, as answering the call does anyway.
 */
async function functionOf(id: string): Promise<string | null> {
  const action: unknown = await getServerFnById(id, { origin: 'client' });
  const meta = typeof action === 'function' && 'serverFnMeta' in action ? action.serverFnMeta : undefined;
  return meta && typeof meta === 'object' && 'id' in meta && meta.id === id && 'name' in meta && typeof meta.name === 'string'
    ? meta.name
    : null;
}

export default { fetch: withRequestEndpoint(entry.fetch, routeOf, functionOf) };
