import { expect, test } from '@playwright/test';

// The built server routes through withFederation (packages/web/src/server.ts) into
// handleFederationRequest (packages/federation/src/http.ts). A negotiated page (`/`, `/u/<name>`,
// `/c/<name>`) says Vary: Accept whichever side answers; other paths do not.
const varies = (vary: string | undefined) => /(^|,)\s*accept\s*(,|$)/i.test(vary ?? '');
const activity = { accept: 'application/activity+json' };

test('GET / asking for ActivityPub JSON serves the instance actor, with Vary: Accept', async ({ request }) => {
  const response = await request.get('/', { headers: activity });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/activity+json');
  expect(varies(response.headers().vary)).toBe(true);
  const text = await response.text();
  expect(text).not.toContain('PRIVATE KEY');
  const actor = JSON.parse(text);
  expect(actor).toMatchObject({ type: 'Application', inbox: expect.stringMatching(/\/inbox$/) });
  expect(actor.publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  // Lemmy and PieFed show the NodeInfo node name beside this name.
  expect(actor.preferredUsername).toBeTruthy();
});

test('GET / from a browser renders the page and has the same Vary', async ({ request }) => {
  const response = await request.get('/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(varies(response.headers().vary)).toBe(true);
});

test('a path that does not negotiate has no Vary: Accept', async ({ request }) => {
  const response = await request.get('/healthz', { headers: activity });
  expect(response.status()).toBe(200);
  expect(varies(response.headers().vary)).toBe(false);
});

test('a page path with no actor behind it renders the UI, not a federation error', async ({ request }) => {
  const response = await request.get('/u/nobody-is-here', { headers: activity });
  // Whatever status the UI gives the page, it is HTML, never a federation answer.
  expect(response.headers()['content-type']).toContain('text/html');
  expect(varies(response.headers().vary)).toBe(true);
});

test('WebFinger and NodeInfo name the instance actor', async ({ request }) => {
  const actor = await (await request.get('/', { headers: activity })).json();
  // The instance actor is named after the host, so its handle is name@name.
  const name: string = actor.preferredUsername;
  const webfinger = await request.get(`/.well-known/webfinger?resource=${encodeURIComponent(`acct:${name}@${name}`)}`);
  expect(webfinger.status()).toBe(200);
  expect(webfinger.headers()['content-type']).toContain('application/jrd+json');
  expect((await webfinger.json()).links).toContainEqual({
    rel: 'self',
    type: 'application/activity+json',
    href: actor.id,
    properties: { 'https://www.w3.org/ns/activitystreams#type': 'Application' },
  });
  expect((await request.get('/.well-known/webfinger?resource=acct:nobody@nowhere.test')).status()).toBe(404);

  // The discovery document links absolute URLs on the configured origin; ask this server for their paths.
  const discovery = await (await request.get('/.well-known/nodeinfo')).json();
  expect(discovery.links.map((link: { href: string }) => new URL(link.href).pathname)).toEqual(['/nodeinfo/2.0', '/nodeinfo/2.1']);
  const nodeinfo = await (await request.get('/nodeinfo/2.1')).json();
  expect(nodeinfo).toMatchObject({
    version: '2.1',
    software: { name: 'peblish' },
    protocols: ['activitypub'],
    openRegistrations: false,
    metadata: { nodeName: actor.name ?? name },
  });
  expect(nodeinfo.usage).toMatchObject({ users: { total: expect.any(Number) }, localPosts: expect.any(Number) });
});

test('the inbox takes POSTs and, until the pipeline is live, answers 503 with Retry-After', async ({ request }) => {
  const response = await request.post('/inbox', { data: '{}', headers: { 'content-type': 'application/activity+json' } });
  expect(response.status()).toBe(503);
  expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
  expect((await request.get('/inbox')).status()).toBe(405);
});
