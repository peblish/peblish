import { globSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { BlockedDestinationError, createSafeFetch, FetchTimeoutError, safeFetch, type SafeFetchInit } from './fetch.ts';

// Stub servers live on loopback, which the real predicate refuses, so these tests build their
// own fetcher: "public" is ::1 and "private" is 127.0.0.1. Two servers share one port, one per
// family, so a URL reaches whichever address the connection was pinned to.
const PUBLIC = '::1';
const PRIVATE = '127.0.0.1';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Stub = { hits: Seen[]; server: http.Server };
const servers: http.Server[] = [];
afterEach(async () => {
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

function listen(host: string, port: number, handler: http.RequestListener): Promise<Stub> {
  const hits: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ hits, server }));
  });
}

/** A "public" server on ::1 and a "private" one on 127.0.0.1, on the same port. */
async function pair(handler: http.RequestListener, privateHandler: http.RequestListener = (_req, res) => res.end('private')) {
  for (let attempt = 0; ; attempt++) {
    const open = await listen(PUBLIC, 0, handler);
    const port = (open.server.address() as AddressInfo).port;
    try {
      return { open, secret: await listen(PRIVATE, port, privateHandler), port };
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((done) => open.server.close(done));
    }
  }
}

const hosts: Record<string, string[]> = {
  'open.test': [PUBLIC],
  'secret.test': [PRIVATE],
  'both.test': [PUBLIC, PRIVATE],
};
const fetcher = createSafeFetch({
  async resolve(hostname) {
    return hosts[hostname] ?? [];
  },
  isPublic: (address) => address === PUBLIC,
});
const init = (extra: Partial<SafeFetchInit> = {}): SafeFetchInit => ({
  schemes: ['http:'],
  maxRedirects: 3,
  maxBytes: 10_000,
  timeoutMs: 2_000,
  ...extra,
});
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString();

test('DNS rebinding: the connection goes to the address that was checked, never to a later answer', async () => {
  const { open, secret, port } = await pair((_req, res) => res.end('public'));
  // The name resolves to a public address at the check and to a private one afterwards.
  const answers = [[PUBLIC], [PRIVATE], [PRIVATE]];
  const rebinding = createSafeFetch({ resolve: async () => answers.shift() ?? [PRIVATE], isPublic: (address) => address === PUBLIC });
  const response = await rebinding(`http://rebind.test:${port}/x`, init());
  expect(text(response.body)).toBe('public');
  expect(secret.hits).toEqual([]);
  expect(open.hits.map((hit) => hit.headers.host)).toEqual([`rebind.test:${port}`]);
  expect(answers).toHaveLength(2);
});

test('a host with any private address is refused before a connection, and so is a private literal', async () => {
  const { open, secret, port } = await pair((_req, res) => res.end('public'));
  await expect(fetcher(`http://both.test:${port}/`, init())).rejects.toBeInstanceOf(BlockedDestinationError);
  await expect(fetcher(`http://secret.test:${port}/`, init())).rejects.toBeInstanceOf(BlockedDestinationError);
  // The real client, with the real predicate, refuses loopback and every other private range.
  for (const url of [
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fe80::1]/',
    'http://localhost/',
    'http://0x7f.1/',
    'http://2130706433/',
  ]) {
    await expect(safeFetch(url, init()), url).rejects.toBeInstanceOf(BlockedDestinationError);
  }
  expect([...open.hits, ...secret.hits]).toEqual([]);
});

test('credentials in a URL, other schemes and malformed URLs are refused', async () => {
  const refused = (url: string, schemes: SafeFetchInit['schemes'] = ['https:', 'http:']) =>
    expect(safeFetch(url, init({ schemes })), url).rejects.toBeInstanceOf(BlockedDestinationError);
  await refused('https://user:secret@example.com/');
  await refused('https://user@example.com/');
  await refused('ftp://example.com/');
  await refused('file:///etc/passwd');
  await refused('javascript:alert(1)');
  await refused('not a url');
  // Only the schemes the caller lists: federation delivery asks for https alone.
  await refused('http://example.com/', ['https:']);
});

test('a redirect is checked again: to a private address it is refused, and no further than maxRedirects is followed', async () => {
  const { open, secret, port } = await pair((req, res) => {
    const redirect = (location: string, status = 302) => (res.writeHead(status, { location }), res.end());
    if (req.url === '/to-private') return redirect(`http://secret.test:${port}/secret`);
    if (req.url === '/to-private-literal') return redirect(`http://127.0.0.1:${port}/secret`);
    if (req.url === '/one') return redirect('/two');
    if (req.url === '/two') return redirect('/three');
    if (req.url === '/to-ftp') return redirect('ftp://open.test/');
    res.end(`at ${req.url}`);
  });
  const base = `http://open.test:${port}`;
  await expect(fetcher(`${base}/to-private`, init())).rejects.toBeInstanceOf(BlockedDestinationError);
  await expect(fetcher(`${base}/to-private-literal`, init())).rejects.toBeInstanceOf(BlockedDestinationError);
  await expect(fetcher(`${base}/to-ftp`, init())).rejects.toBeInstanceOf(BlockedDestinationError);
  expect(secret.hits).toEqual([]);

  const followed = await fetcher(`${base}/one`, init());
  expect([followed.status, text(followed.body), followed.url]).toEqual([200, 'at /three', `${base}/three`]);
  // Out of redirects, the 3xx comes back as it is (federation delivery asks for none).
  for (const [maxRedirects, last] of [
    [0, '/one'],
    [1, '/two'],
  ] as const) {
    const stopped = await fetcher(`${base}/one`, init({ maxRedirects }));
    expect([stopped.status, stopped.url, stopped.headers.get('location')]).toEqual([
      302,
      `${base}${last}`,
      last === '/one' ? '/two' : '/three',
    ]);
  }
  expect(open.hits.length).toBe(3 + 3 + 1 + 2);
});

test('a 303 turns a POST into a GET without its body; a 307 keeps both', async () => {
  const { open, port } = await pair((req, res) => {
    if (req.url === '/see-other') return (res.writeHead(303, { location: '/done' }), res.end());
    if (req.url === '/temporary') return (res.writeHead(307, { location: '/done' }), res.end());
    res.end('done');
  });
  const post = (path: string) =>
    fetcher(
      `http://open.test:${port}${path}`,
      init({ method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain', signature: 'sig' } }),
    );
  await post('/see-other');
  await post('/temporary');
  const summary = open.hits.map((hit) => [
    hit.method,
    hit.url,
    hit.body,
    hit.headers['content-type'] ?? null,
    hit.headers.signature ?? null,
  ]);
  expect(summary).toEqual([
    ['POST', '/see-other', 'payload', 'text/plain', 'sig'],
    ['GET', '/done', '', null, null],
    ['POST', '/temporary', 'payload', 'text/plain', 'sig'],
    ['POST', '/done', 'payload', 'text/plain', null],
  ]);
});

test('the response is cut at maxBytes and says so', async () => {
  const { port } = await pair((_req, res) => res.end('x'.repeat(5_000)));
  const cut = await fetcher(`http://open.test:${port}/`, init({ maxBytes: 100 }));
  expect([cut.status, cut.body.length, cut.truncated]).toEqual([200, 100, true]);
  const whole = await fetcher(`http://open.test:${port}/`, init({ maxBytes: 5_000 }));
  expect([whole.body.length, whole.truncated]).toEqual([5_000, undefined]);
});

test('a server that never answers, or stalls inside the body, times out', async () => {
  const { port } = await pair((req, res) => {
    if (req.url === '/silent') return;
    res.write('start');
  });
  const slow = (path: string) => fetcher(`http://open.test:${port}${path}`, init({ timeoutMs: 150 }));
  const started = Date.now();
  await expect(slow('/silent')).rejects.toBeInstanceOf(FetchTimeoutError);
  await expect(slow('/stalls')).rejects.toBeInstanceOf(FetchTimeoutError);
  expect(Date.now() - started).toBeLessThan(1_500);
});

test('no client headers, cookies, Referer or forwarding addresses go upstream', async () => {
  const { open, port } = await pair((_req, res) => res.end('ok'));
  await fetcher(
    `http://open.test:${port}/`,
    init({
      headers: {
        Accept: 'application/activity+json',
        'User-Agent': 'peblish-test',
        Cookie: 'peblish.session=secret',
        Referer: 'https://viewer.example/page',
        Origin: 'https://viewer.example',
        Authorization: 'Bearer secret',
        'X-Forwarded-For': '203.0.113.9',
        Forwarded: 'for=203.0.113.9',
        'X-Real-IP': '203.0.113.9',
        'CF-Connecting-IP': '203.0.113.9',
        Host: 'evil.example',
      },
    }),
  );
  expect(Object.keys(open.hits[0]?.headers ?? {}).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
  expect(open.hits[0]?.headers.host).toBe(`open.test:${port}`);
});

test('product code never imports createSafeFetch, the only way around the real address check', () => {
  const root = join(import.meta.dirname, '../../..');
  const importers = globSync('*/src/**/*.{ts,tsx}', { cwd: root })
    .filter((file) => !/\.(test|test-d)\.tsx?$/.test(file) && !file.startsWith('core/src/net/fetch.ts') && !file.includes('/__fixtures__/'))
    .filter((file) => /\bimport\b[^;]*\bcreateSafeFetch\b/s.test(readFileSync(join(root, file), 'utf8')));
  expect(importers).toEqual([]);
});
