import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The built web server's probes and shutdown, each against its own server process: /healthz
// never touches the database, /readyz answers 503 with Retry-After within its timeout when
// the database is unusable, and SIGTERM after a database-backed request exits cleanly.

const entry = join(import.meta.dirname, '../../packages/web/.output/server/index.mjs');

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = portOf(server);
  server.close();
  await once(server, 'close');
  return port;
}

type Booted = { origin: string; child: ChildProcess; output: () => string };

async function boot(databaseUrl: string | undefined): Promise<Booted> {
  const port = await freePort();
  // CI and TEST turn off srvx's graceful shutdown, which the image runs with.
  const { CI: _ci, TEST: _test, DATABASE_URL: _url, ...env } = process.env;
  const child = spawn(process.execPath, [entry], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  const origin = `http://127.0.0.1:${port}`;
  await expect
    .poll(
      () =>
        fetch(`${origin}/healthz`).then(
          (response) => response.status,
          () => 0,
        ),
      { timeout: 15_000 },
    )
    .toBe(200);
  return { origin, child, output: () => output };
}

async function stop({ child }: Booted): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(resolve, 10_000, 'timeout'));
  const result = await Promise.race([exited.then(() => child.exitCode), timeout]);
  if (result === 'timeout') child.kill('SIGKILL');
  return result === 'timeout' ? null : result;
}

/** A TCP server that accepts connections and never answers: a database that hangs. */
async function silentDatabase(): Promise<{ url: string; server: Server }> {
  const server = createServer(() => {}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `postgres://peblish:peblish@127.0.0.1:${portOf(server)}/peblish`, server };
}

async function probe(origin: string, path: string) {
  const started = Date.now();
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, retryAfter: response.headers.get('retry-after'), seconds: (Date.now() - started) / 1_000 };
}

test.describe('server lifecycle', () => {
  test('a hanging database: /readyz is a bounded 503 with Retry-After, /healthz stays 200', async () => {
    const database = await silentDatabase();
    const server = await boot(database.url);
    try {
      const ready = await probe(server.origin, '/readyz');
      expect(ready).toMatchObject({ status: 503, retryAfter: '5' });
      expect(ready.seconds).toBeLessThan(4);
      expect((await probe(server.origin, '/healthz')).status).toBe(200);
    } finally {
      await stop(server);
      database.server.close();
    }
  });

  for (const [name, url] of [
    ['no DATABASE_URL', undefined],
    ['an invalid DATABASE_URL', 'not a database url'],
  ] as const) {
    test(`${name}: /readyz is 503 with Retry-After, not 500`, async () => {
      const server = await boot(url);
      try {
        expect(await probe(server.origin, '/readyz')).toMatchObject({ status: 503, retryAfter: '5' });
        expect((await probe(server.origin, '/healthz')).status).toBe(200);
      } finally {
        await stop(server);
      }
    });
  }

  test('a healthy database: /readyz is 200, and SIGTERM afterwards exits cleanly', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is unset: run eval "$(sh scripts/lane.sh <lane>)" first');
    const server = await boot(databaseUrl);
    expect(await probe(server.origin, '/readyz')).toMatchObject({ status: 200, retryAfter: null });
    expect(await stop(server)).toBe(0);
    expect(server.output()).not.toMatch(/error/i);
  });
});
