import { boundaryWanted, installLogBoundary } from './log-boundary.ts';

/** True only under the Vite dev server (vite.config.ts `define`, from Vite's command); false in every build. */
declare const __PEBLISH_DEV_SERVER__: boolean;

// Imported by the first Nitro plugin (server/log-boundary-plugin.ts), which runs before the server
// listens, and again first by the SSR entry (src/server.ts). The build carries two copies of a
// module both the Nitro entry and the SSR bundle import, so the flag lives on globalThis and the
// console is wrapped once.
const installed = globalThis as { __peblishLogBoundary?: boolean };
const devServer = typeof __PEBLISH_DEV_SERVER__ === 'boolean' ? __PEBLISH_DEV_SERVER__ : undefined;
if (boundaryWanted(devServer) && !installed.__peblishLogBoundary) {
  installed.__peblishLogBoundary = true;
  installLogBoundary();
}
