import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { bytes } from '../media/__fixtures__/images.ts';
import { BlockedDestinationError, createSafeFetch, type SafeFetchInit, type SafeResponse } from '../net/fetch.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedSetting } from '../testing/seed-a.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { fetchLinkPreview } from './preview.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

const principal = async (options: { emailVerified?: boolean } = {}) => localUser((await seedAccount('poster', options)).actorId);
const mediaRows = () => db().select().from(media);

type Reply = { status?: number; type?: string; body: Uint8Array | string } | Error;
/** A fetcher answering from a table; records what it was asked. */
function table(replies: Record<string, Reply>) {
  const calls: { url: string; init: SafeFetchInit }[] = [];
  const fetch = async (url: string, init: SafeFetchInit): Promise<SafeResponse> => {
    calls.push({ url, init });
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request for ${url}`);
    if (reply instanceof Error) throw reply;
    const body = typeof reply.body === 'string' ? Buffer.from(reply.body) : reply.body;
    return {
      status: reply.status ?? 200,
      headers: new Headers(reply.type ? { 'content-type': reply.type } : {}),
      body,
      url,
    };
  };
  return { fetch, calls };
}

const html = (head: string) => ({ type: 'text/html; charset=utf-8', body: `<html><head>${head}</head><body></body></html>` });
const PAGE = 'https://news.example/story';
const IMAGE = 'https://news.example/cover.jpg';
const story = html(
  `<title>Fallback</title><meta property="og:title" content="The story"><meta property="og:description" content="What happened"><meta property="og:image" content="/cover.jpg">`,
);

test('a preview carries the title, the description and the picture URL, and stores nothing', async () => {
  const { fetch, calls } = table({ [PAGE]: story });
  const result = await fetchLinkPreview(await principal(), PAGE, { fetch });
  expect(result).toEqual({
    ok: true,
    title: 'The story',
    description: 'What happened',
    urlContentType: 'text/html',
    thumbnailUrl: IMAGE,
  });
  // The picture is the proxy's to fetch when a page shows it: no request for it, no row, no object, no event.
  expect(calls.map((call) => call.url)).toEqual([PAGE]);
  expect([(await mediaRows()).length, await outboxEvents()]).toEqual([0, []]);
  // The request is bounded and asks politely; the page may redirect, the safe client checks each hop.
  expect(calls[0]?.init).toMatchObject({ schemes: ['https:', 'http:'], maxRedirects: 3, timeoutMs: 5000 });
  expect([...new Headers(calls[0]?.init.headers).keys()].sort()).toEqual(['accept', 'user-agent']);
});

test('the kill switch stops previews before anything is fetched', async () => {
  await seedSetting('remote_media.enabled', false);
  const { fetch, calls } = table({});
  expect(await fetchLinkPreview(await principal(), PAGE, { fetch })).toEqual({ ok: false, reason: 'site.disabled' });
  expect(calls).toEqual([]);
});

test('an account that cannot post cannot make the server fetch a URL', async () => {
  const { fetch, calls } = table({});
  expect(await fetchLinkPreview(await principal({ emailVerified: false }), PAGE, { fetch })).toEqual({
    ok: false,
    reason: 'auth.email_unverified',
  });
  expect(await fetchLinkPreview({ kind: 'anonymous' }, PAGE, { fetch })).toEqual({ ok: false, reason: 'auth.required' });
  expect(calls).toEqual([]);
});

test('a link to an image is an image post: its type is reported and nothing is stored', async () => {
  const { fetch } = table({ [IMAGE]: { type: 'application/octet-stream', body: bytes('png') } });
  const result = await fetchLinkPreview(await principal(), IMAGE, { fetch });
  expect(result).toMatchObject({ ok: true, urlContentType: 'image/png', title: null, thumbnailUrl: null });
  expect((await mediaRows()).length).toBe(0);
});

test('a page that cannot be fetched, or is not a page, gives an empty preview and never an error', async () => {
  const empty = { ok: true, title: null, description: null, thumbnailUrl: null };
  const { fetch } = table({
    'https://blocked.example/': new BlockedDestinationError('private address'),
    'https://down.example/': new Error('connect ECONNREFUSED'),
    'https://gone.example/': { status: 404, type: 'text/html', body: 'not here' },
    'https://data.example/': { type: 'application/json', body: '{"a":1}' },
  });
  const user = await principal();
  for (const url of ['https://blocked.example/', 'https://down.example/', 'https://gone.example/']) {
    expect(await fetchLinkPreview(user, url, { fetch }), url).toMatchObject({ ...empty, urlContentType: null });
  }
  expect(await fetchLinkPreview(user, 'https://data.example/', { fetch })).toMatchObject({
    ...empty,
    urlContentType: 'application/json',
  });
  expect((await mediaRows()).length).toBe(0);
});

test('pages in a legacy charset are decoded as they declare themselves', async () => {
  const latin1 = Buffer.from('<html><head><meta charset="iso-8859-1"><title>Café crème</title></head></html>', 'latin1');
  const { fetch } = table({ [PAGE]: { type: 'text/html', body: latin1 } });
  expect(await fetchLinkPreview(await principal(), PAGE, { fetch })).toMatchObject({ ok: true, title: 'Café crème' });
});

// One run through the real client against stub servers: redirects, relative image URLs and
// headers as a remote site sees them. Loopback stands in for "public" in this test only.
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

test('through safeFetch: a redirecting page and a relative picture URL, with no cookies or viewer headers', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/short') return (res.writeHead(302, { location: '/article' }), res.end());
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<head><title>Article</title><meta property="og:image" content="/pic.png"></head>`);
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(bytes('png'));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '::1', done));
  const port = (server.address() as AddressInfo).port;
  const fetch = createSafeFetch({ resolve: async () => ['::1'], isPublic: (address) => address === '::1' });
  const result = await fetchLinkPreview(await principal(), `http://site.test:${port}/short`, { fetch });
  // The redirect was followed and the relative picture resolved against the page it ended on; the picture itself is not requested.
  expect(result).toMatchObject({
    ok: true,
    title: 'Article',
    urlContentType: 'text/html',
    thumbnailUrl: `http://site.test:${port}/pic.png`,
  });
  expect(seen.map((headers) => headers.host)).toEqual([`site.test:${port}`, `site.test:${port}`]);
  for (const headers of seen)
    expect(Object.keys(headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
});
