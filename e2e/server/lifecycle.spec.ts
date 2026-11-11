import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The built web server's probes, shutdown and log, each against its own server process: /healthz
// never touches the database, /readyz answers 503 with Retry-After within its timeout when
// the database is unusable, SIGTERM after a database-backed request exits cleanly, and a client
// that leaves mid-request writes nothing to the log while a real failure still does, and a
// failed page's log line names no value from its address.

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

/** Sends a GET for `path` on a raw connection and closes it after `ms`, before any reply: a browser that navigated on. */
async function leaveEarly(origin: string, path: string, ms: number): Promise<void> {
  const { hostname, port } = new URL(origin);
  const socket = connect(Number(port), hostname);
  await once(socket, 'connect');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nSec-Fetch-Site: same-origin\r\n\r\n`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  socket.destroy();
}

/** The lane's database, which the specs that need real data boot their servers with. */
function laneDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is unset: run lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env" first');
  return url;
}

/** What the server logged, without its start-up line. */
const logLines = (server: Booted) =>
  server
    .output()
    .split('\n')
    .filter((line) => line && !line.startsWith('➜ Listening on:'));

test.describe('server lifecycle', () => {
  // These start their own servers from the local build; against BASE_URL there is no build to start.
  test.skip(Boolean(process.env.BASE_URL), 'starts its own servers from packages/web/.output');

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

  test('a client that leaves mid-request writes nothing to the log', async () => {
    // The hanging database holds the page loader and the media proxy open until the client leaves.
    const database = await silentDatabase();
    const server = await boot(database.url);
    try {
      await leaveEarly(server.origin, '/', 500);
      await leaveEarly(server.origin, '/media/proxy/signature/target', 500);
      // Long enough for the server to see each close and settle the request it was serving.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      // Nothing at all once the start-up line is set aside: no stack, and no quieter line either.
      expect(logLines(server)).toEqual([]);
    } finally {
      await stop(server);
      database.server.close();
    }
  });

  test('a page that fails on the server is still logged', async () => {
    const server = await boot('not a database url');
    try {
      expect((await fetch(`${server.origin}/`)).status).toBeGreaterThanOrEqual(500);
      await expect.poll(() => server.output()).toMatch(/error/i);
    } finally {
      await stop(server);
    }
  });

  test("a page whose search parameters fail logs one line without the visitor's values", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is unset: run lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env" first');
    const server = await boot(databaseUrl);
    try {
      const marker = 'MARKER-typed-by-a-visitor';
      const search = new URLSearchParams({ error: JSON.stringify({ a: marker }) });
      expect((await fetch(`${server.origin}/post/00000000-0000-0000-0000-000000000000?${search}`)).status).toBe(500);
      await expect.poll(() => server.output()).toContain('SearchParamError');
      const logged = server
        .output()
        .split('\n')
        .filter((line) => line && !line.startsWith('➜'));
      expect(logged).toEqual(['route /post/$id/ failed: SearchParamError (error: domain)']);
    } finally {
      await stop(server);
    }
  });

  test("a profile whose handle the loader refuses logs one line naming the parameter, never the visitor's value", async () => {
    const server = await boot(laneDatabase());
    try {
      const marker = 'MARKER-typed-by-a-visitor@example.test';
      // loadProfile takes a handle of at most 300 characters; its validator refuses the rest.
      const response = await fetch(`${server.origin}/u/${'a'.repeat(310)}${encodeURIComponent(marker)}`);
      expect(response.status).toBe(500);
      await expect.poll(() => server.output()).toContain('failed');
      expect(server.output()).not.toContain('MARKER');
      expect(logLines(server)).toEqual(['route /u/$handle/ failed: InputError (handle: maxLength)']);
    } finally {
      await stop(server);
    }
  });

  test("no address a visitor can type into a route's path parameters puts it in the log", async () => {
    const server = await boot(laneDatabase());
    try {
      const marker = encodeURIComponent(`${'a'.repeat(310)}MARKER-typed-by-a-visitor@example.test`);
      const uuid = '00000000-0000-0000-0000-000000000000';
      for (const path of [
        `/u/${marker}/edit`,
        `/c/${marker}`,
        `/c/${marker}/edit`,
        `/post/${marker}`,
        `/post/${uuid}/comments/${marker}`,
        `/invite/${marker}`,
        `/${marker}`,
        `/admin/pages/${marker}/${marker}`,
      ]) {
        const response = await fetch(`${server.origin}${path}`, { redirect: 'manual' });
        expect(response.status, path).toBeLessThan(600);
      }
      // Give the last request's log line time to arrive.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(server.output()).not.toContain('MARKER');
      for (const line of logLines(server)) expect(line).toMatch(/^route \S+ failed: \S+/);
    } finally {
      await stop(server);
    }
  });

  test('a healthy database: /readyz is 200, and SIGTERM afterwards exits cleanly', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is unset: run lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env" first');
    const server = await boot(databaseUrl);
    expect(await probe(server.origin, '/readyz')).toMatchObject({ status: 200, retryAfter: null });
    expect(await stop(server)).toBe(0);
    expect(server.output()).not.toMatch(/error/i);
  });
});
