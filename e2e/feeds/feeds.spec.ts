import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane C1 end to end, on the built server and the lane database: the five feeds hydrate and
// pass axe, the sorts and the density switch, the next page with and without JavaScript, the
// sensitive-content gate in the feed, and a remote picture never reaching the page as it is.
// The steps share seeded posts, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  viewer: { name: string };
  undeclared: { name: string };
  communities: { local: string; remote: string };
  posts: Record<string, string>;
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-c1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

/** The card titles on the page, in order. */
const titles = (page: Page) => page.locator('.feed-list .pb-post__title a').allTextContents();
/** The posts' addresses: titles repeat across runs on a lane database, so a page-overlap check compares these. */
const postLinks = (page: Page) =>
  page.locator('.feed-list .pb-post__title a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));

/** The server-rendered HTML of `path` for this page's session, before any script runs. */
async function html(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'commit' });
  if (!response) throw new Error('no response');
  return response.text();
}

test.describe('anyone', () => {
  for (const path of ['/', '/all', '/local', '/popular', '/moderating']) {
    test(`${path} hydrates, names its feed and has no axe violations`, async ({ page }) => {
      const log = recordConsole(page);
      await gotoHydrated(page, path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        { '/': 'Local', '/all': 'All', '/local': 'Local', '/popular': 'Popular', '/moderating': 'Moderating' }[path]!,
      );
      await expect(page.getByRole('group', { name: 'View' })).toBeVisible();
      await expectAccessible(page);
      expect(log.hydrationProblems()).toEqual([]);
    });
  }

  test('a signed-out visitor to Moderating is asked to sign in', async ({ page }) => {
    await gotoHydrated(page, '/moderating');
    await expect(page.getByRole('heading', { name: 'Sign in to see your moderating feed' })).toBeVisible();
    await expect(page.locator('#pb-main').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/auth/sign-in?redirect=%2Fmoderating',
    );
  });

  test('the toolbar sorts by link: New, Old and Top with its period, and an unknown sort falls back', async ({ page }) => {
    await gotoHydrated(page, '/all');
    await expect(page.getByRole('group', { name: 'Sort' }).getByRole('link', { name: 'Hot' })).toHaveAttribute('aria-current', 'true');
    await page.getByRole('group', { name: 'Sort' }).getByRole('link', { name: 'Top' }).click();
    await page.waitForURL('**/all?sort=top');
    await expect(page.getByRole('group', { name: 'Top of' }).getByRole('link', { name: 'Day' })).toHaveAttribute('aria-current', 'true');
    // The period is a link too: the top of the week is the best scored post first.
    await page.getByRole('group', { name: 'Top of' }).getByRole('link', { name: 'Week' }).click();
    await page.waitForURL('**/all?sort=top&period=week');
    expect((await titles(page))[0]).toBe(`Picture ${seed.suffix}`);
    await page.getByRole('group', { name: 'Sort' }).getByRole('link', { name: 'New' }).click();
    await page.waitForURL('**/all?sort=new');
    await expect(page.getByRole('group', { name: 'Top of' })).toHaveCount(0);
    await gotoHydrated(page, '/all?sort=bogus&period=nonsense');
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('group', { name: 'Sort' }).getByRole('link', { name: 'Hot' })).toHaveAttribute('aria-current', 'true');
  });

  test('the density switch changes the cards and the choice is kept', async ({ page }) => {
    await gotoHydrated(page, '/all?sort=top');
    const first = page.locator('.feed-list article').first();
    await expect(first).toHaveAttribute('data-density', 'classic');
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Compact' }).click();
    await expect(first).toHaveAttribute('data-density', 'compact');
    await page.reload();
    await expect(page.locator('.feed-list article').first()).toHaveAttribute('data-density', 'compact');
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Classic' }).click();
    await expect(page.locator('.feed-list article').first()).toHaveAttribute('data-density', 'classic');
  });

  test('a sensitive post is not in the signed-out HTML, and a remote picture is never sent as its own URL', async ({ page }) => {
    const text = await html(page, '/all?sort=top');
    expect(text).not.toContain(`Sensitive ${seed.suffix}`);
    expect(text).toContain(`Picture ${seed.suffix}`);
    // The card shows the link's domain as text, but the picture's URL (the thumbnail's and the image post's own link) is never in the page.
    expect(text).not.toContain(`images.example.test/${seed.suffix}.png`);
    expect(text).not.toMatch(/<img[^>]*images\.example\.test/);
    // Cutting the address to its host keeps what the card draws from it: the image mark and the domain.
    const card = page.locator('.feed-list article', { hasText: `Picture ${seed.suffix}` });
    await expect(card).toHaveAttribute('data-kind', 'image');
    await expect(card.locator('.pb-post__domain')).toHaveText('(images.example.test)');
  });
});

test.describe('a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('the toolbar speaks German, with no axe violations', async ({ page }) => {
    await gotoHydrated(page, '/all?sort=top');
    await expect(page.getByRole('group', { name: 'Sortierung' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Top aus' }).getByRole('link', { name: 'Woche' })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe('a viewer', () => {
  test('home is Subscribed: what they follow and nothing else, with their own lists in the sidebar', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Subscribed');
    const list = await titles(page);
    // Hot puts the best scored and newest first.
    expect(list[0]).toBe(`Picture ${seed.suffix}`);
    expect(list.some((title) => title.startsWith('Other ') || title.startsWith('Local '))).toBe(false);
    const side = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(side.getByRole('link', { name: 'Subscribed' })).toBeVisible();
    await expect(side.getByRole('link', { name: 'Moderating' })).toBeVisible();
    await expect(side.getByRole('link', { name: new RegExp(`^!${seed.communities.remote}@`) })).toBeVisible();
    await expect(side.getByRole('navigation', { name: 'Communities' })).toContainText('Remote (1)');
    await expectAccessible(page);
  });

  test('Moderating is the posts of the communities they moderate', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/moderating?sort=new');
    expect(await titles(page)).toEqual([`Local ${seed.suffix}`]);
  });

  test('next pages join up in order, by link and by the first-page link', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/?sort=new');
    const first = await titles(page);
    expect(first).toHaveLength(20);
    expect(first.slice(0, 2)).toEqual([`Picture ${seed.suffix}`, `Followed ${seed.suffix} 01`]);
    await page.getByRole('link', { name: 'Next page' }).click();
    await page.waitForURL(/\?sort=new&cursor=/);
    await expect.poll(() => titles(page)).not.toEqual(first);
    const second = await titles(page);
    expect(second).toHaveLength(20);
    expect(second[0]).toBe(`Followed ${seed.suffix} 20`);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect.poll(() => titles(page)).not.toEqual(second);
    const third = await titles(page);
    expect(third.at(-1)).toBe(`Followed ${seed.suffix} 45`);
    expect([...first, ...second, ...third]).toHaveLength(46);
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to the first page' }).click();
    await page.waitForURL('**/?sort=new');
    expect(await titles(page)).toEqual(first);
  });

  test('a vote from the feed is kept', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/?sort=new');
    const card = page.locator('.feed-list article', { hasText: `Followed ${seed.suffix} 02` });
    const up = card.getByRole('button', { name: 'Upvote' });
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await up.click();
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await expect(async () => {
      await page.reload();
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(
        page.locator('.feed-list article', { hasText: `Followed ${seed.suffix} 02` }).getByRole('button', { name: 'Upvote' }),
      ).toHaveAttribute('aria-pressed', 'true');
    }).toPass();
  });

  test('a person who has declared 16+ gets the sensitive post hidden behind show; one who has not does not get it', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/all?sort=top');
    const card = page.locator('.feed-list article[data-sensitive]', { hasText: `Sensitive ${seed.suffix}` });
    await expect(card).toHaveAttribute('data-hidden', 'true');
    await card.getByRole('button', { name: 'hidden, show' }).click();
    await expect(card).not.toHaveAttribute('data-hidden');
    await page.context().clearCookies();
    await signedIn(page, seed.undeclared.name);
    expect(await html(page, '/all?sort=top')).not.toContain(`Sensitive ${seed.suffix}`);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the sort and the next page are plain links', async ({ page }) => {
    await page.goto('/all?sort=new');
    const first = await postLinks(page);
    expect(first).toHaveLength(20);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    const second = await postLinks(page);
    expect(second).toHaveLength(20);
    expect(second.filter((link) => first.includes(link))).toEqual([]);
    await page.getByRole('group', { name: 'Sort' }).getByRole('link', { name: 'Top' }).click();
    await expect(page).toHaveURL(/sort=top/);
    expect((await titles(page))[0]).toBe(`Picture ${seed.suffix}`);
  });
});
