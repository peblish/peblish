import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// A sensitive post's card in a feed, revealed (CN3 of review 2). The proxy enforces access, not
// presentation: a reader with a 16+ declaration and the default Hide NSFW choice gets the
// thumbnail; a signed-out or undeclared reader gets a 404. A remote host cannot be real here, so
// a stub on loopback stands in, and the proxy's own private-address refusal (403, the stub never
// asked) is the sign that every access check passed and the image was fetched; a check that
// refused answers 404 before any fetch. The bytes path to a 200 is media/proxy/-handler.test.ts.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

const root = join(import.meta.dirname, '../..');
type Seed = { postId: string; title: string; community: string; password: string; declared: string; undeclared: string };

let stub: http.Server;
const hits: string[] = [];
let seed: Seed;
test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end();
  });
  await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
  const imageUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/thumb.png`;
  seed = JSON.parse(
    execFileSync('node', ['packages/core/src/testing/seed-b2.ts', 'sensitive-thumbnail-post', imageUrl], { cwd: root, encoding: 'utf8' }),
  ) as Seed;
});
test.afterAll(async () => {
  await new Promise((done) => stub.close(done));
});

/**
 * The proxy's status for `path`, fetched from inside the page, so the browser sends its own
 * cookies (the API client leaves out the session cookie, which is Secure, on this http origin).
 */
const fetched = (page: Page, path: string) => page.evaluate(async (url) => (await fetch(url, { cache: 'no-store' })).status, path);

/** The same, from a new browser context signed in as `name`, or signed out. */
async function statusFor(browser: Browser, path: string, name?: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await gotoHydrated(page, '/auth/sign-in');
    if (name) {
      await signIn(page, `@${name}`, seed.password);
      await landed(page, '/');
    }
    return await fetched(page, path);
  } finally {
    await context.close();
  }
}

test('a declared reader reveals a sensitive card and the proxy fetches its remote thumbnail; signed out or undeclared it is a 404', async ({
  page,
  browser,
}) => {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.declared}`, seed.password);
  await landed(page, '/');
  // No Hide NSFW cookie: the default, which hides.
  expect((await page.context().cookies()).filter((cookie) => cookie.name.startsWith('peblish_nsfw'))).toEqual([]);

  const thumbnail = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/media/proxy/'));
  await gotoHydrated(page, `/c/${seed.community}`);
  const card = page.locator('article[data-sensitive]', { hasText: seed.title });
  await expect(card).toHaveAttribute('data-hidden', 'true');
  const src = await card.locator('.pb-post__thumb img').getAttribute('src');
  expect(src).toMatch(/^\/media\/proxy\//);
  await card.getByRole('button', { name: 'hidden, show' }).click();
  await expect(card).not.toHaveAttribute('data-hidden');

  // The browser's request for the picture passed every access check and reached the fetch.
  const answered = await thumbnail;
  expect(new URL(answered.url()).pathname).toBe(src);
  expect(answered.status()).toBe(403);
  expect(await fetched(page, src!)).toBe(403);

  // The same URL for a signed-out or undeclared reader stops at the sign-in and age gates.
  // The helper carries a session: the declared reader, from a new context, still passes.
  expect(await statusFor(browser, src!, seed.declared)).toBe(403);
  expect(await statusFor(browser, src!)).toBe(404);
  expect(await statusFor(browser, src!, seed.undeclared)).toBe(404);
  expect(hits).toEqual([]);
});
