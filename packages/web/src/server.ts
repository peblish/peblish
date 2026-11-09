import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { withFederation } from './server/federation.ts';
import { withSecurityHeaders } from './server/headers.ts';

// The server entry (TanStack Start picks up src/server.ts): federation first, then the UI;
// HTML responses get the security baseline.
export default createServerEntry({ fetch: withSecurityHeaders(withFederation(handler.fetch)) });
