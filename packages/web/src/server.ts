import { createServerEntry, createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { withClientAborts } from './server/client-gone.ts';
import { withFederation } from './server/federation.ts';
import { withSecurityHeaders } from './server/headers.ts';

// The server entry (TanStack Start picks up src/server.ts): federation first, then the UI;
// HTML responses get the security baseline. The handler is built here rather than taken from
// `@tanstack/react-start/server-entry`, whose default export already wraps it in Start's logging
// catch: withClientAborts must see an error first, so a client that left mid-request is not
// logged while every other error still reaches that catch (createServerEntry) and its log line.
export default createServerEntry({
  fetch: withClientAborts(withSecurityHeaders(withFederation(createStartHandler(defaultStreamHandler)))),
});
