import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedWorld, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { siteName } from '../support/site-name.ts';

// Page titles ("<page> · <site>", shell/title.ts) for the pages that once had only the site's
// name: four admin tabs, the report form, About, the not-found and error pages, a community's
// not-found page and the NSFW gate. e2e/shell/shell.spec.ts covers the shell's own table.

/** A search value /post/<id> cannot take: the route fails before its loader (e2e/shell/error-page.spec.ts). */
const failingPage = '/post/00000000-0000-0000-0000-000000000000?error=%7B%22a%22%3A1%7D';

test('signed out: About, the not-found page and the error page name themselves', async ({ page }) => {
  for (const [path, title] of [
    ['/about', 'About'],
    ['/no-such-page', 'Page not found'],
    [failingPage, 'Something went wrong'],
  ] as const) {
    await gotoHydrated(page, path);
    await expect(page).toHaveTitle(`${title} · ${await siteName(page)}`);
  }
});

test.describe('a flagged community, signed out', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

  test('the gate is titled by its heading, never by the community it hides, and a missing community by its own page', async ({ page }) => {
    const seed = JSON.parse(
      execFileSync('node', ['packages/core/src/testing/seed-comm.ts', 'e2e'], {
        cwd: join(import.meta.dirname, '../..'),
        encoding: 'utf8',
      }),
    ) as { communities: { nsfw: { handle: string } }; posts: { inNsfw: string } };
    for (const [path, title] of [
      [`/c/${seed.communities.nsfw.handle}`, 'This community is NSFW'],
      [`/post/${seed.posts.inNsfw}`, 'This post is NSFW'],
      ['/c/no_such_community_here', 'Community not found'],
    ] as const) {
      await gotoHydrated(page, path);
      await expect(page).toHaveTitle(`${title} · ${await siteName(page)}`);
    }
  });
});

test.describe('signed in as the admin', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  // One two-factor sign-in, which can wait most of a 30 s code window (e2e/bans/bans.spec.ts).
  test.describe.configure({ timeout: 90_000 });
  let world: World;
  test.beforeAll(() => {
    world = seedWorld();
  });

  test('the admin tabs and the report form name themselves', async ({ page }) => {
    await signedInAdmin(page, world);
    for (const [path, title] of [
      ['/admin/bans', 'Banned from this instance'],
      ['/admin/peers', 'Peers'],
      ['/admin/media', 'Media'],
      ['/admin/reports', 'Reports'],
      [`/report?kind=post&id=${world.posts.author}`, 'Report this post'],
    ] as const) {
      await gotoHydrated(page, path);
      await expect(page).toHaveTitle(`${title} · ${await siteName(page)}`);
    }
  });
});

test.describe('in German', () => {
  test.use({ locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE' } });

  test('About is titled in the request locale', async ({ page }) => {
    await gotoHydrated(page, '/about');
    await expect(page).toHaveTitle(`Über uns · ${await siteName(page)}`);
  });
});
