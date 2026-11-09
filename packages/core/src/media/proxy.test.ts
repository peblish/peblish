import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { outbox } from '../db/tables/outbox.ts';
import { createSafeFetch } from '../net/fetch.ts';
import { bytes } from './__fixtures__/images.ts';
import { fetchProxiedImage, proxyLimits } from './proxy.ts';

// A stub "remote host" on loopback. The proxy's own client refuses loopback, so tests that
// need to reach the stub use a client that calls ::1 public; the refusal test uses the real one.
const servers: http.Server[] = [];
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
afterEach(async () => {
  seen.length = 0;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((done) => {
          server.close(done);
          server.closeAllConnections();
        }),
    ),
  );
});

async function remote(reply: (url: string) => { status?: number; type?: string; body: Uint8Array | string }) {
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const { status = 200, type, body } = reply(req.url ?? '');
    res.writeHead(status, type ? { 'content-type': type } : {});
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '::1', done));
  const { port } = server.address() as AddressInfo;
  const fetch = createSafeFetch({ resolve: async () => ['::1'], isPublic: (address) => address === '::1' });
  return { url: (path: string) => `http://img.test:${port}${path}`, fetch };
}

test('a raster image is returned with the type its bytes show, not the type the host claims', async () => {
  const host = await remote(() => ({ type: 'text/plain', body: bytes('webpLossy') }));
  expect(await fetchProxiedImage(host.url('/a'), host.fetch)).toEqual({ ok: true, type: 'image/webp', body: expect.any(Uint8Array) });
});

test('SVG, HTML, an image that claims another type and an empty body are refused with 415', async () => {
  const bodies = {
    '/svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '/html': '<html><script>alert(1)</script></html>',
    '/empty': '',
  };
  const host = await remote((path) => ({ type: 'image/png', body: bodies[path as keyof typeof bodies] ?? '' }));
  for (const path of Object.keys(bodies))
    expect(await fetchProxiedImage(host.url(path), host.fetch), path).toMatchObject({ ok: false, status: 415 });
});

test('an image past the size limit is refused with 413, not cut', async () => {
  const host = await remote(() => ({ type: 'image/png', body: Buffer.concat([bytes('png'), Buffer.alloc(proxyLimits.bytes)]) }));
  expect(await fetchProxiedImage(host.url('/big'), host.fetch)).toMatchObject({ ok: false, status: 413 });
});

test('a remote error is a 502, and an unreachable host too', async () => {
  const host = await remote(() => ({ status: 404, type: 'text/html', body: 'gone' }));
  expect(await fetchProxiedImage(host.url('/a'), host.fetch)).toMatchObject({ ok: false, status: 502 });
  const dead = createSafeFetch({ resolve: async () => ['::1'], isPublic: () => true });
  expect(await fetchProxiedImage('http://dead.test:1/a.png', dead)).toMatchObject({ ok: false, status: 502 });
});

test('the real client refuses private and loopback addresses with 403 and reaches nobody', async () => {
  const host = await remote(() => ({ type: 'image/png', body: bytes('png') }));
  const port = new URL(host.url('/')).port;
  for (const url of [
    `http://127.0.0.1:${port}/a.png`,
    `http://[::1]:${port}/a.png`,
    `http://localhost:${port}/a.png`,
    'http://10.0.0.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    expect(await fetchProxiedImage(url), url).toMatchObject({ ok: false, status: 403, why: 'blocked' });
  }
  expect(seen).toEqual([]);
});

test('nothing of the viewer goes upstream, and nothing fetched is stored', async () => {
  const host = await remote(() => ({ type: 'image/png', body: bytes('png') }));
  await fetchProxiedImage(host.url('/pic.png?x=1'), host.fetch);
  expect(seen.map((request) => request.url)).toEqual(['/pic.png?x=1']);
  // Host, a fixed user agent and what the fetch itself needs: no cookie, referrer, language, forwarded address or auth.
  expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
  expect(seen[0]?.headers['user-agent']).toBe('peblish-media-proxy/1');
  expect([(await db().select().from(media)).length, (await db().select().from(outbox)).length]).toEqual([0, 0]);
});
