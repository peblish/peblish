import { definePlugin } from 'nitro';
import { withUnmatchedEndpoint } from './endpoint.ts';
import './log-boundary-install.ts';

// The first Nitro plugin (vite.config.ts): Nitro runs its plugins while it builds the app, before
// the server listens, so the log boundary is in place before the first request, and before
// anything h3 or srvx can print about a request that never reaches a route (Nitro loads the SSR
// bundle, and src/server.ts with it, only with the first ordinary request).
export default definePlugin((nitro) => {
  nitro.fetch = withUnmatchedEndpoint(nitro.fetch);
});
