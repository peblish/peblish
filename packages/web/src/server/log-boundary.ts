import { AsyncLocalStorage } from 'node:async_hooks';
import { logLine } from '@peblish/core/log-line';

/**
 * The endpoint a request is serving, as its method and route template ("POST /submit/",
 * "GET /u/$handle/"), never its path: every line logged while serving it starts with it, so an
 * operator can tell which page failed without the path parameters a visitor typed. On globalThis:
 * the build carries two copies of a module both the Nitro entry and the SSR bundle import.
 */
const holder = globalThis as { __peblishRequestEndpoint?: AsyncLocalStorage<string> };
export const requestEndpoint = (holder.__peblishRequestEndpoint ??= new AsyncLocalStorage<string>());

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
      const endpoint = requestEndpoint.getStore();
      out(endpoint ? `[${endpoint}] ${logLine(args)}` : logLine(args));
    };
  }
}
