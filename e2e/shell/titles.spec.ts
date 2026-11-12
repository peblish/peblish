import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedWorld, signedIn, signedInAdmin, type World } from '../modlog/support.ts';
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
    // A route that names itself still leaves a failure to the root's title.
    ['/report?kind=%7B%22a%22%3A1%7D', 'Something went wrong'],
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

  test('the admin tabs and the report form name themselves, and leave a failure to the root', async ({ page }) => {
    await signedInAdmin(page, world);
    for (const [path, title] of [
      ['/admin/bans', 'Banned from this instance'],
      ['/admin/peers', 'Peers'],
      ['/admin/media', 'Media'],
      ['/admin/reports', 'Reports'],
      [`/report?kind=post&id=${world.posts.author}`, 'Report this post'],
      // A failure or a missing target under a route that names itself takes the root's title.
      ['/admin/reports?tab=%7B%22a%22%3A1%7D', 'Something went wrong'],
      ['/admin/media?section=%7B%22a%22%3A1%7D', 'Something went wrong'],
      ['/report?kind=post&id=00000000-0000-4000-8000-000000000000', 'Page not found'],
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

/** Follows a link inside the page, as a reader clicking one does: the router navigates in the client and keeps its loader data. */
async function clientNavigate(page: Page, href: string) {
  await page.evaluate((target) => {
    const link = document.createElement('a');
    link.href = target;
    link.id = 'pb-test-link';
    link.textContent = 'go';
    document.querySelector('main')?.append(link);
  }, href);
  await page.locator('#pb-test-link').click();
  await page.waitForURL((url) => `${url.pathname}${url.search}` === new URL(href, 'http://x').pathname + new URL(href, 'http://x').search);
}

test.describe('after a client-side navigation', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  let world: World;
  test.beforeAll(() => {
    world = seedWorld();
  });

  test("a page's own title from its loader data gives way to the error and not-found titles", async ({ page }) => {
    const post = `/post/${world.posts.author}`;
    const missingPost = '/post/00000000-0000-4000-8000-000000000000';
    const permalink = `${post}/comments/${world.comments.spam}`;
    for (const [start, next, title] of [
      [post, `${post}?error=%7B%22a%22%3A1%7D`, 'Something went wrong'],
      [post, missingPost, 'Page not found'],
      [permalink, `${post}/comments/00000000-0000-4000-8000-000000000000`, 'Page not found'],
      [`/c/${world.community.handle}`, '/c/no_such_community_here', 'Community not found'],
      ['/about', '/privacy', 'Page not found'],
    ] as const) {
      await gotoHydrated(page, start);
      const site = await siteName(page);
      await expect(page).not.toHaveTitle(`${title} · ${site}`);
      await clientNavigate(page, next);
      await expect(page, `${start} then ${next}`).toHaveTitle(`${title} · ${site}`);
    }
  });
});

test.describe('a community removed while its page is open', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

  test('reloading the same page, as its join form does, gives the community not-found page its own title', async ({ page }) => {
    const world = seedWorld();
    await signedIn(page, world, world.author.name);
    await gotoHydrated(page, `/c/${world.community.handle}`);
    const site = await siteName(page);
    await expect(page).not.toHaveTitle(`Community not found · ${site}`);
    execFileSync('node', ['packages/core/src/testing/seed-modf.ts', 'remove-community', world.community.id], {
      cwd: join(import.meta.dirname, '../..'),
    });
    // The form posts by fetch and invalidates the router: the same match loads again, now not found.
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Community not found' })).toBeVisible();
    await expect(page).toHaveTitle(`Community not found · ${site}`);
  });
});
