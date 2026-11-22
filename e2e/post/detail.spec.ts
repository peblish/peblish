import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The Commons post page on the lane database: its view header, the exact date and time in the meta line and the
// rail, Share and Copy link, the spoiler badge, and the gate standing in for a sensitive post. The thread under it
// is e2e/comments' (thread.spec.ts); the page's reading, voting and the author's actions are post.spec.ts's.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  secret: string;
  community: { handle: string };
  author: { name: string };
  posts: { plain: string; deletable: string; sensitive: string };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-b1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

const url = (id: string) => `/post/${id}`;
const header = (handle: string) => ({ name: `Post in !${handle}` });

test('the view header names the community, and the meta line and the rail give the exact date and time', async ({ page }) => {
  // Wide enough for the rail beside the centre column and the open sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, url(seed.posts.plain));
  await expect(page.getByRole('link', header(seed.community.handle))).toHaveAttribute('href', `/c/${seed.community.handle}`);
  const posted = page.locator('.post-meta time');
  await expect(posted).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} [AP]M UTC$/);
  const rail = page.getByRole('complementary', { name: 'About this post' });
  await expect(rail.getByRole('link', { name: new RegExp(`!${seed.community.handle}`) })).toBeVisible();
  await expect(rail).toContainText('In this thread');
  await expect(rail.getByRole('link', { name: `@${seed.author.name}` })).toBeVisible();
  await expect(rail.locator('time')).toHaveText((await posted.textContent())!);
});

test.describe('Share and Copy link', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  const status = '.post-share__status';

  test('Copy link puts the post’s address on the clipboard and says so for a moment', async ({ page, baseURL }) => {
    await gotoHydrated(page, url(seed.posts.plain));
    await page.getByRole('button', { name: 'Copy link' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(url(seed.posts.plain), baseURL).href);
    await expect(page.locator(status)).toHaveText('Link copied.');
    await expect(page.locator(status)).toHaveText('', { timeout: 6000 });
  });

  test('Share gives the share sheet the address and the title, and says nothing after', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      Object.assign(window, { shared });
      Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: async (data: unknown) => void shared.push(data) });
    });
    await gotoHydrated(page, url(seed.posts.plain));
    const title = await page.locator('#post-title').textContent();
    await page.getByRole('button', { name: 'Share' }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared))
      .toEqual([{ url: new URL(url(seed.posts.plain), baseURL).href, title }]);
    await expect(page.locator(status)).toHaveText('');
  });

  test('without a share sheet, Share copies the address instead', async ({ page, baseURL }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined }));
    await gotoHydrated(page, url(seed.posts.plain));
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.locator(status)).toHaveText('Link copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(url(seed.posts.plain), baseURL).href);
  });
});

test('a post whose text holds a spoiler says so beside its title', async ({ page }) => {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.author.name}`, seed.password);
  await landed(page, '/');
  await gotoHydrated(page, url(seed.posts.deletable));
  await expect(page.locator('.post-flags')).toHaveCount(0);
  const saved = await page.evaluate(
    async (id) =>
      (
        await fetch(`/submit?edit=${id}`, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: new URLSearchParams({
            type: 'text',
            title: 'A post with an ending',
            body: 'Read on.\n\n::: spoiler The ending\nIt was a dream.\n:::',
          }),
        })
      ).status,
    seed.posts.deletable,
  );
  expect(saved).toBe(200);
  await gotoHydrated(page, url(seed.posts.deletable));
  await expect(page.locator('.post-flags')).toHaveText('Spoiler');
  await expect(page.locator('.post-text details')).toHaveCount(1);
});

test('the gate stands in for a sensitive post: no thread, no reply and no Share, under the view header', async ({ page }) => {
  await gotoHydrated(page, url(seed.posts.sensitive));
  await expect(page.getByText('This post is NSFW')).toBeVisible();
  await expect(page.getByRole('link', header(seed.community.handle))).toBeVisible();
  await expect(page.locator('#comments')).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Reply' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(seed.secret);
});
