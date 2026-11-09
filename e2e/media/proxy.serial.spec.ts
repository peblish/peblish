import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// The remote-media proxy on the built server (decision 5). A remote host cannot be real here, so
// a stub image server on loopback stands in: it must see no request at all, neither from the
// browser (a page never points at it) nor from the server (its proxy refuses a private address).

const root = join(import.meta.dirname, '../..');
/** packages/core/src/testing/seed-b2.ts against the lane database. */
const seed = (...args: string[]): unknown =>
  JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-b2.ts', ...args], { cwd: root, encoding: 'utf8' }));

let stub: http.Server;
let hits: string[] = [];
let imageUrl = '';
test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  });
  await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
  imageUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/remote.png`;
});
test.afterAll(async () => {
  await new Promise((done) => stub.close(done));
});
test.beforeEach(() => {
  hits = [];
});

test('an unsigned, altered or made-up proxy URL is a 404', async ({ request }) => {
  const signed = seed('proxy-path', imageUrl) as string;
  const [signature, target] = signed.split('/').slice(3) as [string, string];
  const forged = Buffer.from('https://internal.example/').toString('base64url');
  for (const path of [
    '/media/proxy/AAAA/BBBB',
    `/media/proxy/${signature}/${forged}`,
    `/media/proxy/${signature.slice(1)}/${target}`,
    `/media/proxy/x/${target}`,
  ]) {
    const response = await request.get(path);
    expect([path, response.status(), response.headers()['cache-control']]).toEqual([path, 404, 'no-store']);
  }
  expect(hits).toEqual([]);
});

test('a signed URL to a private address is refused by the proxy and never reaches the host', async ({ request }) => {
  const response = await request.get(seed('proxy-path', imageUrl) as string);
  expect([response.status(), response.headers()['cache-control'], response.headers().location]).toEqual([403, 'no-store', undefined]);
  expect(hits).toEqual([]);
});

test('the kill switch turns the proxy off', async ({ request }) => {
  const path = seed('proxy-path', 'https://img.example/a.png') as string;
  try {
    seed('remote-media', 'false');
    expect((await request.get(path)).status()).toBe(404);
  } finally {
    seed('remote-media', 'true');
  }
});

test('a post page loads a remote image from /media/proxy and never from the remote host', async ({ page, request }) => {
  const post = seed('remote-image-post', imageUrl) as { postId: string };
  // The post page is lane B1's; this spec runs once it is in the tree.
  test.skip((await request.get(`/post/${post.postId}`)).status() === 404, 'the post page lands with lane B1');
  const requested: string[] = [];
  page.on('request', (outgoing) => requested.push(outgoing.url()));
  const proxied = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/media/proxy/'));
  await gotoHydrated(page, `/post/${post.postId}`);
  // The browser asks the proxy, which refuses the stub's loopback address (a real host would be fetched and relayed).
  expect((await proxied).status()).toBe(403);
  const sources = await page.locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  const own = sources.filter((src) => src?.startsWith('/media/proxy/'));
  expect(own.length).toBeGreaterThan(0);
  expect(sources.filter((src) => src && !src.startsWith('/') && !src.startsWith(new URL(page.url()).origin))).toEqual([]);
  expect(requested.filter((url) => url.startsWith(new URL(imageUrl).origin))).toEqual([]);
  expect(hits).toEqual([]);
});
