import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The component gallery is off unless PEBLISH_UI_KIT=1, and not only its page: the server
// function that renders its bodies is a public endpoint of its own, so it must refuse too.
test.skip(Boolean(process.env.BASE_URL), 'needs the build output beside this repository');

const ssr = join(import.meta.dirname, '../../packages/web/.output/server/_ssr');

/** The id the build gave loadKitContent (packages/web/src/routes/kit/-render.ts), as the server bundle spells it. */
function kitFunctionId(): string {
  for (const file of readdirSync(ssr).filter((name) => /^router-.*\.mjs$/.test(name))) {
    const id = /loadKitContent = createServerFn\(\{ method: "GET" \}\)\.handler\(createSsrRpc\("([a-f0-9]+)"/.exec(
      readFileSync(join(ssr, file), 'utf8'),
    )?.[1];
    if (id) return id;
  }
  throw new Error('loadKitContent is not in the server bundle: update this spec to how the build spells server functions');
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  server.close();
  await once(server, 'close');
  return address.port;
}

/** What a browser's own fetch of a server function sends: the same-origin hint the server's request check wants. */
const call = (origin: string, id: string) => fetch(`${origin}/_serverFn/${id}`, { headers: { 'sec-fetch-site': 'same-origin' } });

test('the gallery bodies are served where the gallery is on, and refused where it is off', async ({ baseURL }) => {
  const id = kitFunctionId();
  const on = await (await call(baseURL!, id)).text();
  test.skip(!on.includes('contentHtml'), 'the server under test does not run the gallery (PEBLISH_UI_KIT=1)');

  const port = await freePort();
  const { PEBLISH_UI_KIT: _on, CI: _ci, TEST: _test, ...env } = process.env;
  const child = spawn(process.execPath, [join(ssr, '../index.mjs')], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  try {
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
    expect((await fetch(`${origin}/kit`)).status).toBe(404);
    const off = await (await call(origin, id)).text();
    expect(off).toContain('isNotFound');
    expect(off).not.toContain('contentHtml');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
