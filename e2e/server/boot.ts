import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { expect } from '@playwright/test';

// The built web server, started on its own port by the server specs (e2e/server/*.spec.ts), with
// everything it writes to stdout and stderr kept for the specs that read its log.

const entry = join(import.meta.dirname, '../../packages/web/.output/server/index.mjs');

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}

export async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = portOf(server);
  server.close();
  await once(server, 'close');
  return port;
}

export type Booted = { origin: string; child: ChildProcess; output: () => string };

export async function boot(databaseUrl: string | undefined, extra: Record<string, string> = {}): Promise<Booted> {
  const port = await freePort();
  // CI and TEST turn off srvx's graceful shutdown, which the image runs with.
  const { CI: _ci, TEST: _test, DATABASE_URL: _url, ...env } = process.env;
  const child = spawn(process.execPath, [entry], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }), ...extra },
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

export async function stop({ child }: Booted): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(resolve, 10_000, 'timeout'));
  const result = await Promise.race([exited.then(() => child.exitCode), timeout]);
  if (result === 'timeout') child.kill('SIGKILL');
  return result === 'timeout' ? null : result;
}

/** A TCP server that accepts connections and never answers: a database that hangs. */
export async function silentDatabase(): Promise<{ url: string; server: Server }> {
  const server = createServer(() => {}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `postgres://peblish:peblish@127.0.0.1:${portOf(server)}/peblish`, server };
}

/** The lane's database, which the specs that need real data boot their servers with. */
export function laneDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is unset: run lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env" first');
  return url;
}

/** What the server logged, without its start-up line. */
export const logLines = (server: Booted) =>
  server
    .output()
    .split('\n')
    .filter((line) => line && !line.startsWith('➜ Listening on:'));
