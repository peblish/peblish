import { expect, test } from '@playwright/test';

// The built server routes through withFederation (packages/web/src/server.ts). Until lane
// FED-A answers, an ActivityPub request for a page renders the HTML shell; either way the
// negotiated page says Vary: Accept, and other paths do not.
const varies = (vary: string | undefined) => /(^|,)\s*accept\s*(,|$)/i.test(vary ?? '');

test('GET / asking for ActivityPub JSON renders the shell for now, with Vary: Accept', async ({ request }) => {
  const response = await request.get('/', { headers: { accept: 'application/activity+json' } });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(await response.text()).toContain('<html');
  expect(varies(response.headers().vary)).toBe(true);
});

test('GET / from a browser has the same Vary', async ({ request }) => {
  const response = await request.get('/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  expect(response.status()).toBe(200);
  expect(varies(response.headers().vary)).toBe(true);
});

test('a path that does not negotiate has no Vary: Accept', async ({ request }) => {
  const response = await request.get('/healthz', { headers: { accept: 'application/activity+json' } });
  expect(response.status()).toBe(200);
  expect(varies(response.headers().vary)).toBe(false);
});
