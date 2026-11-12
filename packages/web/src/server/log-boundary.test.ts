import { expect, test } from 'vitest';
import { installLogBoundary } from './log-boundary.ts';

const marker = 'MARKER-typed@example.test';

function fakeConsole() {
  const written: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      written.push({ method, args });
  const target = {
    error: record('error'),
    warn: record('warn'),
    log: record('log'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    dir: record('dir'),
  };
  return { target, written };
}

test('every console method writes one string with no line break and nothing the visitor typed', () => {
  const { target, written } = fakeConsole();
  installLogBoundary(target);
  // TanStack Start's reporter: console.error(error), the database error quoting the parameter.
  const database = Object.assign(new Error(`Failed query: insert\nparams: x\u0000${marker}`), { code: '22021' });
  target.error(database);
  // Better Auth's default logger: a formatted string, then the error.
  target.error(`2026 ERROR [Better Auth]: Failed to run background task:`, new Error(`550 <${marker}>`));
  target.warn({ url: `/u/${marker}` });
  target.trace('trace', new Error(marker));
  target.dir({ email: marker });
  target.log('a\nb');
  for (const { args } of written) {
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe('string');
    expect(args[0]).not.toMatch(/[\r\n]/);
    expect(args[0]).not.toContain(marker);
  }
  expect(written.map(({ method }) => method)).toEqual(['error', 'error', 'warn', 'error', 'log', 'log']);
  expect(written[5]?.args[0]).toBe('a b');
});
