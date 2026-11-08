import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { withFederation } from './server/federation.ts';

// The server entry (TanStack Start picks up src/server.ts): federation first, then the UI.
export default createServerEntry({ fetch: withFederation(handler.fetch) });
