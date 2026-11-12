import { logLine } from '@peblish/core/log-line';
import { requestScope } from '@peblish/core/log-scope';

/**
 * Whether this process gets the log boundary: every built server does, whatever NODE_ENV was when
 * it was built or is now; only the Vite dev server shows a developer raw errors. Anything that runs
 * this module without Vite's define (it never should) gets the boundary too.
 */
export const boundaryWanted = (devServer: boolean | undefined) => devServer !== true;

/** The console methods the boundary covers; trace and dir print the one line too, with no stack or tree. */
const methods = ['error', 'warn', 'log', 'info', 'debug', 'trace', 'dir'] as const;

type Writer = (...args: unknown[]) => void;

/**
 * Routes every console method of `target` through core's logLine, so whatever logs in the web
 * process (TanStack Start's own reporters, srvx, Better Auth, the database library, the app)
 * writes one line with no message, stack, value or field a visitor could have chosen. Installed
 * once by server/log-boundary-install.ts, for the built server only.
 */
export function installLogBoundary(target: Pick<Console, (typeof methods)[number]> = console): void {
  const write = { error: target.error.bind(target), warn: target.warn.bind(target), log: target.log.bind(target) };
  const sink: Record<(typeof methods)[number], Writer> = {
    error: write.error,
    warn: write.warn,
    log: write.log,
    info: target.info.bind(target),
    debug: target.debug.bind(target),
    trace: write.error,
    dir: write.log,
  };
  for (const method of methods) {
    const out = sink[method];
    target[method] = (...args: unknown[]) => {
      // The endpoint being served (server/endpoint.ts): the page, never its path.
      const endpoint = requestScope.getStore();
      out(endpoint ? `[${endpoint}] ${logLine(args)}` : logLine(args));
    };
  }
}
