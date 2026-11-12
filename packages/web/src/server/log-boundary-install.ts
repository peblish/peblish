import { installLogBoundary } from './log-boundary.ts';

// Imported first by the server entry (src/server.ts), so the boundary is in place before any
// other module can log. The built server only: under the Vite dev server a developer sees raw
// errors. The build carries two copies of a module both the Nitro entry and the SSR bundle
// import, so the flag lives on globalThis and the console is wrapped once.
const installed = globalThis as { __peblishLogBoundary?: boolean };
if (!import.meta.env.DEV && !installed.__peblishLogBoundary) {
  installed.__peblishLogBoundary = true;
  installLogBoundary();
}
