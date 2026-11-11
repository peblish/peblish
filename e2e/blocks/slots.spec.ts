import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The Block buttons in the action slots (PR #26: BlockForm puts its fixed fields in the form's
// address), pressed for real: on a post row, a comment row and a community page with scripts on,
// and on a post row with scripts off. Then two things the hydrated form must not do: reload the
// page's data after a refusal, and pull the visitor back to the page they left while a block
// was still on its way. Each test has a viewer of its own from a fresh seed.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Seed = {
  password: string;
  viewers: string[];
  noisy: { name: string };
  friend: { name: string };
  community: { name: string };
  posts: { friend: string; friendTitle: string };
  comments: { noisy: string };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-e1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

async function signedIn(browser: Browser, name: string, javaScriptEnabled = true): Promise<Page> {
  const page = await (await browser.newContext({ javaScriptEnabled })).newPage();
  await page.goto('/auth/sign-in');
  if (javaScriptEnabled) await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await signIn(page, `@${name}`, seed.password);
  await page.waitForURL('/');
  return page;
}

const isBlockPost = (request: Request) => request.method() === 'POST' && new URL(request.url()).pathname === '/settings/blocks';
const isServerFn = (request: Request) => new URL(request.url()).pathname.startsWith('/_serverFn/');

/** The post's own row (its article), and the row of the comment that says `text`. */
const postRow = (page: Page) => page.getByRole('article').filter({ hasText: seed.posts.friendTitle }).first();
const commentRow = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text }).last();

/** The names on one tab of the blocks page, read from a fresh load. */
async function blockedOn(page: Page, tab: 'people' | 'communities'): Promise<string> {
  await page.goto(`/settings/blocks?tab=${tab}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Blocks' })).toBeVisible();
  const list = page.getByRole('grid', { name: tab === 'people' ? 'Blocked People' : 'Blocked Communities' });
  return (await list.count()) === 0 ? '' : ((await list.textContent()) ?? '');
}

test('Block on a post row, a comment row and a community page blocks, with scripts on', async ({ browser }) => {
  const page = await signedIn(browser, seed.viewers[0]!);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // The post row: blocks the post's author, stays on the post, and reloads its data.
  await gotoHydrated(page, `/post/${seed.posts.friend}`);
  const reloads: string[] = [];
  page.on('request', (request) => isServerFn(request) && reloads.push(request.url()));
  const sent = page.waitForRequest(isBlockPost);
  await postRow(page).getByRole('button', { name: 'Block', exact: true }).click();
  const request = await sent;
  expect(new URL(request.url()).searchParams.get('intent')).toBe('add');
  expect((await request.response())?.status()).toBe(200);
  await expect.poll(() => reloads.length).toBeGreaterThan(0);
  expect(new URL(page.url()).pathname).toBe(`/post/${seed.posts.friend}`);

  // The comment row: blocks the comment's author, whose comment folds away in place.
  await gotoHydrated(page, `/post/${seed.posts.friend}`);
  await commentRow(page, seed.comments.noisy).getByRole('button', { name: 'Block', exact: true }).first().click();
  await expect(page.getByRole('list', { name: 'Comments' }).first()).toContainText('Hidden: you blocked this person.');
  expect(new URL(page.url()).pathname).toBe(`/post/${seed.posts.friend}`);

  // The community page: blocks the community.
  await gotoHydrated(page, `/c/${seed.community.name}`);
  const community = page.waitForResponse((response) => isBlockPost(response.request()));
  await page.getByRole('button', { name: 'Block community', exact: true }).click();
  expect((await community).status()).toBe(200);

  expect(await blockedOn(page, 'people')).toContain(seed.friend.name);
  expect(await blockedOn(page, 'people')).toContain(seed.noisy.name);
  expect(await blockedOn(page, 'communities')).toContain(seed.community.name);
  expect(errors).toEqual([]);
  await page.context().close();
});

test('Block on a post row blocks with scripts off, and comes back to the post', async ({ browser }) => {
  const page = await signedIn(browser, seed.viewers[1]!, false);
  await page.goto(`/post/${seed.posts.friend}`);
  const answer = page.waitForResponse((response) => isBlockPost(response.request()));
  await postRow(page).getByRole('button', { name: 'Block', exact: true }).click();
  expect((await answer).status()).toBe(303);
  await page.waitForURL(`/post/${seed.posts.friend}`);
  expect(await blockedOn(page, 'people')).toContain(seed.friend.name);
  await page.context().close();
});

test('a refused block shows its message and reloads nothing', async ({ browser }) => {
  const page = await signedIn(browser, seed.viewers[2]!);
  await gotoHydrated(page, `/post/${seed.posts.friend}`);
  // The body wins over the form's address (-post.ts): name an id that is nobody, so the real server refuses.
  await page.route(
    (url) => url.pathname === '/settings/blocks',
    (route) => route.continue({ postData: 'target=019a0000-0000-7000-8000-00000000dead' }),
  );
  const reloads: string[] = [];
  page.on('request', (request) => isServerFn(request) && reloads.push(request.url()));
  const answer = page.waitForResponse((response) => isBlockPost(response.request()));
  await postRow(page).getByRole('button', { name: 'Block', exact: true }).click();
  expect((await answer).status()).toBe(400);
  await expect(postRow(page).getByRole('alert')).toBeVisible();
  // Give a reload the time it would take, then check none was asked for.
  await page.waitForTimeout(1_000);
  expect(reloads).toEqual([]);
  await page.unroute((url) => url.pathname === '/settings/blocks');
  expect(await blockedOn(page, 'people')).not.toContain(seed.friend.name);
  await page.context().close();
});

test('a block answered after the visitor moved on does not throw or pull them back', async ({ browser }) => {
  const page = await signedIn(browser, seed.viewers[3]!);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await gotoHydrated(page, `/post/${seed.posts.friend}`);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/settings/blocks',
    async (route) => {
      await held;
      await route.continue();
    },
  );
  const answer = page.waitForResponse((response) => isBlockPost(response.request()));
  await postRow(page).getByRole('button', { name: 'Block', exact: true }).click();

  // Away to the community by an in-app link while the block waits.
  await page
    .getByRole('link', { name: `!${seed.community.name}`, exact: true })
    .first()
    .click();
  await page.waitForURL(`/c/${seed.community.name}`);
  await expect(page.getByRole('button', { name: 'Block community', exact: true })).toBeVisible();
  release();
  expect((await answer).status()).toBe(200);
  // Give a navigation back the time it would take, then check the visitor is where they went.
  await page.waitForTimeout(1_500);
  expect(new URL(page.url()).pathname).toBe(`/c/${seed.community.name}`);
  expect(errors).toEqual([]);
  // The block itself went through.
  expect(await blockedOn(page, 'people')).toContain(seed.friend.name);
  await page.context().close();
});
