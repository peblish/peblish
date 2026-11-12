import { installLogBoundary } from './log-boundary.ts';

// Imported by the first Nitro plugin (server/log-boundary-plugin.ts), which runs before the server
// listens, and again first by the SSR entry (src/server.ts), which is a second copy in the build. The built server only: under the Vite dev server a developer sees raw
// errors. The build carries two copies of a module both the Nitro entry and the SSR bundle
// import, so the flag lives on globalThis and the console is wrapped once.
const installed = globalThis as { __peblishLogBoundary?: boolean };
if (!import.meta.env.DEV && !installed.__peblishLogBoundary) {
  installed.__peblishLogBoundary = true;
  installLogBoundary();
}
