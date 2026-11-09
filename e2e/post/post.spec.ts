import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane B1 end to end, on the built server and the lane database: the post page for every
// viewer, the sensitive-content gate in the server-rendered HTML, voting, and the author's and
// a moderator's actions with and without JavaScript. The steps share seeded posts, so they run
// in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  secret: string;
  community: { handle: string };
  author: { name: string };
  moderator: { name: string };
  viewer: { name: string };
  undeclared: { name: string };
  posts: {
    plain: string;
    deletable: string;
    removable: string;
    sensitive: string;
    deleted: string;
    longThumbnail: string;
    inRemovedCommunity: string;
    inDeletedCommunity: string;
  };
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

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

/**
 * The server-rendered HTML as this page's session (or none) receives it, before any script
 * runs: the main resource's body, not the DOM. Through the page, not context.request, because
 * the session cookie is Secure (the instance origin is https) and the request context does not
 * send those to http://127.0.0.1.
 */
async function html(page: Page, id: string) {
  const response = await page.goto(url(id), { waitUntil: 'commit' });
  if (!response) throw new Error('no response');
  return { status: response.status(), text: await response.text(), cacheControl: response.headers()['cache-control'] };
}

/** A form post from inside the page, so the session cookie goes with it; the JSON answer says what the server decided. */
async function post(page: Page, id: string, form: Record<string, string>) {
  return page.evaluate(
    async ([target, fields]) => {
      const response = await fetch(target, { method: 'POST', body: new URLSearchParams(fields), headers: { accept: 'application/json' } });
      return { status: response.status, answer: (await response.json()) as { ok?: boolean; error?: string } };
    },
    [url(id), form] as const,
  );
}

/** Opens a post through the router in the same document, as a link inside the app does (shell/client-links.ts). */
async function openPost(page: Page, id: string) {
  await page.evaluate(
    (target) =>
      (
        window as unknown as { __TSR_ROUTER__: { navigate(to: { to: string; params: { id: string } }): Promise<void> } }
      ).__TSR_ROUTER__.navigate({
        to: '/post/$id',
        params: { id: target },
      }),
    id,
  );
}

test.describe('anyone', () => {
  test('a post page hydrates, shows the post and has no axe violations', async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, url(seed.posts.plain));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Plain post');
    await expect(page.locator('.post-text strong')).toHaveText('body');
    await expect(page.getByRole('link', { name: 'example.test' })).toHaveAttribute('href', 'https://example.test/article');
    await expect(page.getByRole('group', { name: 'Vote on this post' })).toBeVisible();
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('the page is personal: never cached; an unknown post is a 404', async ({ page }) => {
    const { status, cacheControl } = await html(page, seed.posts.plain);
    expect([status, cacheControl]).toEqual([200, 'private, no-store']);
    expect((await page.request.get(url('0192f5a0-1234-7abc-8def-0123456789ab'))).status()).toBe(404);
    expect((await page.request.get('/post/not-a-post')).status()).toBe(404);
  });

  test('a deleted post is a readable tombstone with status 200', async ({ page }) => {
    const { status, text } = await html(page, seed.posts.deleted);
    expect(status).toBe(200);
    expect(text).toContain('This post was deleted');
    expect(text).not.toContain('Deleted post');
    expect(text).not.toContain('Deleted body');
    await gotoHydrated(page, url(seed.posts.deleted));
    await expectAccessible(page);
  });

  test('a link post whose remote thumbnail URL is too long to proxy still renders, as a plain link', async ({ page }) => {
    const { status, text } = await html(page, seed.posts.longThumbnail);
    expect(status).toBe(200);
    expect(text).toContain('Long thumbnail post');
    expect(text).toContain('class="post-link" href="https://example.test/long"');
    // No picture: the thumbnail could not be signed, so the page loads nothing from img.example.
    expect(text.includes('<img')).toBe(false);
  });

  test('a post in a removed or deleted community is a 404 with none of its text', async ({ page }) => {
    for (const id of [seed.posts.inRemovedCommunity, seed.posts.inDeletedCommunity]) {
      const { status, text } = await html(page, id);
      expect(status).toBe(404);
      expect(text).not.toContain('Closed post');
    }
  });

  test('a signed-out viewer of a sensitive post gets the gate and none of its text in the HTML', async ({ page }) => {
    const { status, text } = await html(page, seed.posts.sensitive);
    expect(status).toBe(200);
    expect(text).not.toContain(seed.secret);
    expect(text).not.toContain('example.test');
    expect(text).toContain('This post is NSFW');
    expect(text).toContain(`/auth/sign-in?redirect=${encodeURIComponent(url(seed.posts.sensitive))}`);
    expect(text).toContain('name="robots" content="noindex"');
    await gotoHydrated(page, url(seed.posts.sensitive));
    // The shell has its own Sign in link: the gate's is the one inside the page.
    await expect(page.locator('#pb-main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(seed.secret);
    await expectAccessible(page);
  });

  test('forms refuse cross-site posts, and a signed-out post goes to sign-in', async ({ page }) => {
    const target = url(seed.posts.plain);
    const cross = await page.request.post(target, {
      form: { intent: 'delete' },
      headers: { origin: 'https://evil.example' },
      maxRedirects: 0,
    });
    expect(cross.status()).toBe(403);
    const anonymous = await page.request.post(target, { form: { intent: 'delete' }, maxRedirects: 0 });
    expect([anonymous.status(), anonymous.headers().location]).toEqual([303, `${target}?error=auth.required`]);
  });

  test('a form post to an id that is not a uuid is a 404, and no redirect is built from it', async ({ page }) => {
    for (const id of ['not-a-post', '%0D%0Ainjected:%201']) {
      const response = await page.request.post(`/post/${id}`, { form: { intent: 'delete' }, maxRedirects: 0 });
      expect([response.status(), response.headers().location]).toEqual([404, undefined]);
    }
  });
});

test.describe('a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('the post page speaks German to a German browser, hydrates keeping the server’s date, with no axe violations', async ({ page }) => {
    const log = recordConsole(page);
    const response = await page.goto(url(seed.posts.plain), { waitUntil: 'commit' });
    const server = /<time[^>]*>([^<]*)<\/time>/.exec((await response?.text()) ?? '')?.[1];
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('group', { name: 'Für diesen Beitrag abstimmen' })).toBeVisible();
    // The date is German and was formatted once, on the server: hydration printed the same text.
    expect(server).toMatch(/^\d{1,2}\. \p{L}+\.? \d{4}, \d{2}:\d{2} UTC$/u);
    await expect(page.locator('time')).toHaveText(server ?? '');
    await page.waitForLoadState('networkidle');
    expect(log.hydrationProblems()).toEqual([]);
    await expectAccessible(page);
  });
});

test.describe('a viewer', () => {
  test('without a 16+ declaration gets the gate too, not the content', async ({ page }) => {
    await signedIn(page, seed.undeclared.name);
    const { text } = await html(page, seed.posts.sensitive);
    expect(text).not.toContain(seed.secret);
    expect(text).toContain('16 or older');
  });

  test('with a declaration gets the gate while Hide NSFW is on, shows the post once; votes stick', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    const gated = await html(page, seed.posts.sensitive);
    expect(gated.status).toBe(200);
    expect(gated.text).not.toContain(seed.secret);
    expect(gated.text).toContain('Hide NSFW is on');
    await gotoHydrated(page, url(seed.posts.sensitive));
    await page.getByRole('button', { name: 'Show once' }).click();
    await page.waitForURL(`**${url(seed.posts.sensitive)}`);
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.locator('.post-content')).toContainText(seed.secret);
    await expect(page.getByRole('button', { name: 'Hide NSFW' })).toBeVisible();
    await expectAccessible(page);

    // Vote on the plain post: the first tap after hydration counts, and the server keeps it.
    await gotoHydrated(page, url(seed.posts.plain));
    const up = page.getByRole('button', { name: 'Upvote' });
    const score = page.getByRole('group', { name: 'Vote on this post' }).locator('.pb-vote__score');
    await expect(score).toHaveText('0');
    // Wait for the server's answer before reloading: a reload would abort a vote still in flight.
    const answered = () => page.waitForResponse((response) => response.url().includes('/_serverFn/'));
    let voted = answered();
    await up.click();
    await voted;
    await expect(score).toHaveText('1');
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(score).toHaveText('1');
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    voted = answered();
    await page.getByRole('button', { name: 'Downvote' }).click();
    await voted;
    await expect(score).toHaveText('-1');
    voted = answered();
    await page.getByRole('button', { name: 'Downvote' }).click();
    await voted;
    await expect(score).toHaveText('0');
  });

  test('an optimistic vote stays with its post when a link goes to another post in the same document', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, url(seed.posts.plain));
    const score = page.getByRole('group', { name: 'Vote on this post' }).locator('.pb-vote__score');
    const up = page.getByRole('button', { name: 'Upvote' });
    const answered = () => page.waitForResponse((response) => response.url().includes('/_serverFn/'));
    let voted = answered();
    await up.click();
    await voted;
    await expect(score).toHaveText('1');
    await expect(up).toHaveAttribute('aria-pressed', 'true');

    // The router reuses the page component for the next post: the first post's vote must not show on it.
    await page.evaluate(() => {
      (window as unknown as { __survives: boolean }).__survives = true;
    });
    await openPost(page, seed.posts.deletable);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Deletable post');
    await expect(score).toHaveText('0');
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    // Back to the first post: the server's vote, not a copy of the optimistic one.
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Plain post');
    await expect(score).toHaveText('1');
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as unknown as { __survives?: boolean }).__survives)).toBe(true);

    voted = answered();
    await up.click();
    await voted;
    await expect(score).toHaveText('0');
  });

  test('signed out, the arrows are inert', async ({ page }) => {
    await gotoHydrated(page, url(seed.posts.plain));
    await expect(page.getByRole('button', { name: 'Upvote' })).toBeDisabled();
  });
});

test.describe('the author', () => {
  test('deletes and restores their post, hydrated; anyone else sees the tombstone meanwhile', async ({ page, browser }) => {
    await signedIn(page, seed.author.name);
    await gotoHydrated(page, url(seed.posts.deletable));
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/submit?edit=${seed.posts.deletable}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This post was deleted');

    const other = await (await browser.newContext()).newPage();
    expect((await html(other, seed.posts.deletable)).text).not.toContain('Deletable body');
    await other.close();

    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Deletable post');
    await expect(page.locator('.post-text')).toContainText('Deletable body');
  });

  test('deletes and restores without JavaScript: a plain form post, then the page again', async ({ browser }) => {
    const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    await page.goto('/auth/sign-in');
    await signIn(page, `@${seed.author.name}`, seed.password);
    await page.waitForURL('/');
    await page.goto(url(seed.posts.deletable));
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This post was deleted');
    expect(new URL(page.url()).search).toBe('');
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Deletable post');
    await page.close();
  });

  test('is told, in place, when a delete is refused (the post was deleted elsewhere)', async ({ page }) => {
    await signedIn(page, seed.author.name);
    await gotoHydrated(page, url(seed.posts.deletable));
    expect(await post(page, seed.posts.deletable, { intent: 'delete' })).toEqual({ status: 200, answer: { ok: true } });
    // The page still shows the live post: the next delete is refused with the exact reason.
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('alert')).toHaveText('This post was already deleted.');
    expect(await post(page, seed.posts.deletable, { intent: 'restore' })).toEqual({ status: 200, answer: { ok: true } });
  });

  test("cannot delete someone else's post", async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, url(seed.posts.plain));
    expect(await post(page, seed.posts.plain, { intent: 'delete' })).toEqual({ status: 400, answer: { error: 'post.author_required' } });
  });
});
