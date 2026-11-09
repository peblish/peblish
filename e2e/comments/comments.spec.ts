import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane D end to end, on the built server and the lane database: the thread under a post, its
// sorts and pages, the permalink page that continues a deep thread, tombstones, replying through the
// docked bar with and without JavaScript, the author's edit and delete, and the budget for a
// 500-comment thread. The steps share seeded posts, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  author: { name: string };
  replier: { name: string };
  moderator: { name: string };
  unverified: { name: string };
  posts: {
    thread: string;
    tombstones: string;
    removed: string;
    empty: string;
    locked: string;
    paged: string;
    pagedReplies: string;
    big: string;
  };
  comments: {
    first: string;
    firstReply: string;
    second: string;
    third: string;
    chain: string[];
    deleted: string;
    removed: string;
    pagedRoot: string;
  };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-d.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

const postUrl = (id: string) => `/post/${id}`;
const commentUrl = (postId: string, commentId: string) => `/post/${postId}/comments/${commentId}`;

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

/**
 * The server-rendered HTML as this page's session (or none) receives it, before any script
 * runs. Through the page, not context.request, because the session cookie is Secure (the
 * instance origin is https) and the request context does not send those to http://127.0.0.1.
 */
async function html(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'commit' });
  if (!response) throw new Error('no response');
  return { status: response.status(), text: await response.text() };
}

/** A form post from inside the page, so the session cookie goes with it; the JSON answer says what the server decided. */
async function post(page: Page, postId: string, form: Record<string, string>) {
  return page.evaluate(
    async ([target, fields]) => {
      const response = await fetch(target, { method: 'POST', body: new URLSearchParams(fields), headers: { accept: 'application/json' } });
      return { status: response.status, answer: (await response.json()) as { ok?: boolean; id?: string; error?: string } };
    },
    [`/post/${postId}/comments`, form] as const,
  );
}

/** The top-level comments' texts, in the order the page lists them. */
const topLevel = async (page: Page) =>
  (await page.locator('.pb-thread > ul > li > .pb-comment__main > .pb-comment__text').allTextContents()).map((text) => text.trim());

test.describe('anyone', () => {
  test('the thread hydrates, shows the comments with their replies and has no axe violations', async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, postUrl(seed.posts.thread));
    const thread = page.getByRole('list', { name: 'Comments' }).first();
    await expect(thread).toContainText(`First comment ${seed.suffix}`);
    await expect(thread).toContainText(`Reply to first ${seed.suffix}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Comments' })).toBeVisible();
    await expect(page.getByRole('link', { name: '11 comments' })).toBeVisible();
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('signed out, the arrows are inert and there is no reply bar, only a way to sign in', async ({ page }) => {
    await gotoHydrated(page, postUrl(seed.posts.thread));
    await expect(page.locator('.pb-thread').getByRole('button', { name: 'Upvote' }).first()).toBeDisabled();
    await expect(page.getByRole('form', { name: 'Reply' })).toHaveCount(0);
    await expect(page.locator('#comments').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/auth/sign-in?redirect=${encodeURIComponent(postUrl(seed.posts.thread))}`,
    );
  });

  test('a post with no comments says so', async ({ page }) => {
    await gotoHydrated(page, postUrl(seed.posts.empty));
    await expect(page.getByText('No comments yet.')).toBeVisible();
  });

  test('the sort is a form that works without JavaScript and, hydrated, reorders the thread', async ({ page, browser }) => {
    // Without JavaScript the server renders the sort the document asks for.
    const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    await plain.goto(postUrl(seed.posts.thread));
    expect(await topLevel(plain)).toEqual([
      `First comment ${seed.suffix}`,
      `Second comment ${seed.suffix}`,
      `Third comment ${seed.suffix}`,
    ]);
    await plain.getByRole('button', { name: 'New' }).click();
    await expect(plain).toHaveURL(/\?sort=new#comments$/);
    expect(await topLevel(plain)).toEqual([
      `Third comment ${seed.suffix}`,
      `Second comment ${seed.suffix}`,
      `First comment ${seed.suffix}`,
    ]);
    await plain.close();

    await gotoHydrated(page, postUrl(seed.posts.thread));
    await expect(page.getByRole('button', { name: 'Hot' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Old' }).click();
    await expect(page).toHaveURL(/\?sort=old#comments$/);
    await expect(page.getByRole('button', { name: 'Old' })).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => topLevel(page))
      .toEqual([`First comment ${seed.suffix}`, `Second comment ${seed.suffix}`, `Third comment ${seed.suffix}`]);
    await page.getByRole('button', { name: 'New' }).click();
    await expect
      .poll(() => topLevel(page))
      .toEqual([`Third comment ${seed.suffix}`, `Second comment ${seed.suffix}`, `First comment ${seed.suffix}`]);
    // A sort the server does not know is the default, not an error page.
    const odd = await html(page, `${postUrl(seed.posts.thread)}?sort=controversial`);
    expect(odd.status).toBe(200);
  });

  test('top-level comments page by a cursor in the address: plain links, in the sort order, none repeated', async ({ page, browser }) => {
    const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    await plain.goto(`${postUrl(seed.posts.paged)}?sort=old`);
    const first = await topLevel(plain);
    expect(first).toEqual(Array.from({ length: 25 }, (_, index) => `Comment ${index}`));
    await expect(plain.getByRole('link', { name: 'Back to the first comments' })).toHaveCount(0);
    await plain.getByRole('link', { name: 'More comments' }).click();
    await expect(plain).toHaveURL(/\?sort=old&after=[\w-]+#comments$/);
    expect(await topLevel(plain)).toEqual(['Comment 25', 'Comment 26', 'Comment 27']);
    await expect(plain.getByRole('link', { name: 'More comments' })).toHaveCount(0);
    await plain.getByRole('link', { name: 'Back to the first comments' }).click();
    await expect(plain).toHaveURL(/\?sort=old#comments$/);
    expect(await topLevel(plain)).toEqual(first);
    await plain.getByRole('link', { name: 'More comments' }).click();
    const second = plain.url();
    await plain.close();

    // Hydrated, the second page is the same page, and sorting starts over at the first.
    const log = recordConsole(page);
    await gotoHydrated(page, second);
    expect(await topLevel(page)).toEqual(['Comment 25', 'Comment 26', 'Comment 27']);
    await expectAccessible(page);
    await page.getByRole('button', { name: 'New' }).click();
    await expect(page).toHaveURL(/\?sort=new#comments$/);
    await expect.poll(() => topLevel(page)).toEqual(Array.from({ length: 25 }, (_, index) => `Comment ${27 - index}`));
    expect(log.hydrationProblems()).toEqual([]);

    // The links go through the router once hydrated: the next page replaces the list with no page load.
    await gotoHydrated(page, `${postUrl(seed.posts.paged)}?sort=old`);
    await page.evaluate(() => Object.assign(window, { loadedOnce: true }));
    await page.getByRole('link', { name: 'More comments' }).click();
    await expect.poll(() => topLevel(page)).toEqual(['Comment 25', 'Comment 26', 'Comment 27']);
    await expect(page).toHaveURL(/\?sort=old&after=[\w-]+#comments$/);
    await page.getByRole('link', { name: 'Back to the first comments' }).click();
    await expect.poll(() => topLevel(page)).toHaveLength(25);
    await page.goBack();
    await expect.poll(() => topLevel(page)).toEqual(['Comment 25', 'Comment 26', 'Comment 27']);
    expect(await page.evaluate(() => 'loadedOnce' in window)).toBe(true);

    // A cursor that is not one starts at the first page; so does one that belongs to another sort.
    await page.goto(`${postUrl(seed.posts.paged)}?sort=old&after=nonsense`);
    expect(await topLevel(page)).toHaveLength(25);
    await page.goto(second.replace('sort=old', 'sort=new'));
    expect(await topLevel(page)).toHaveLength(25);
  });

  test('the replies under a comment page on its own page too, with the comment itself on every page', async ({ browser }) => {
    const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    await plain.goto(`${commentUrl(seed.posts.pagedReplies, seed.comments.pagedRoot)}?sort=old`);
    await expect(plain.locator('.pb-comment')).toHaveCount(1 + 25);
    // The comment's own page pages its replies, so it offers no link to itself.
    await expect(plain.getByRole('link', { name: 'Continue this thread' })).toHaveCount(0);
    await plain.getByRole('link', { name: 'More replies' }).click();
    await expect(plain).toHaveURL(/\?sort=old&after=[\w-]+#comments$/);
    await expect(plain.locator('.pb-comment')).toHaveCount(1 + 3);
    await expect(plain.locator(`#comment-${seed.comments.pagedRoot} > .pb-comment__main > .pb-comment__text`)).toHaveText('Comment 0');
    await expect(plain.getByRole('link', { name: 'More replies' })).toHaveCount(0);
    await plain.getByRole('link', { name: 'Back to the first replies' }).click();
    await expect(plain.locator('.pb-comment')).toHaveCount(1 + 25);
    await plain.close();
  });

  test('a branch cut at the depth cap continues on its own page', async ({ page }) => {
    await gotoHydrated(page, postUrl(seed.posts.thread));
    // The chain under the second comment goes 8 levels deep; the page draws 6.
    await expect(page.getByText(`Chain level 6 ${seed.suffix}`)).toBeVisible();
    await expect(page.getByText(`Chain level 7 ${seed.suffix}`)).toHaveCount(0);
    const levels = await page.locator('.pb-comment').evaluateAll((items) =>
      Math.max(
        ...items.map((item) => {
          let depth = 0;
          for (let node = item.parentElement; node; node = node.parentElement) if (node.classList.contains('pb-comment')) depth++;
          return depth;
        }),
      ),
    );
    expect(levels).toBe(5);
    await expect(page.getByText('2 more replies')).toBeVisible();
    await page.getByRole('link', { name: 'Continue this thread' }).click();
    await page.waitForURL(commentUrl(seed.posts.thread, seed.comments.chain[5]!));
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    // The permalink starts at level 6 and draws what is under it, with the way back.
    await expect(page.getByText(`Chain level 6 ${seed.suffix}`)).toBeVisible();
    await expect(page.getByText(`Chain level 8 ${seed.suffix}`)).toBeVisible();
    await expect(page.getByText(`First comment ${seed.suffix}`)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View all comments' })).toHaveAttribute('href', `${postUrl(seed.posts.thread)}#comments`);
    await expect(page.getByRole('link', { name: 'View the comment above' })).toHaveAttribute(
      'href',
      commentUrl(seed.posts.thread, seed.comments.chain[4]!),
    );
    await expectAccessible(page);
  });

  test('a comment that is not on that post, and a post that is not there, are 404', async ({ page }) => {
    expect((await page.request.get(commentUrl(seed.posts.empty, seed.comments.first))).status()).toBe(404);
    expect((await page.request.get(commentUrl(seed.posts.thread, '0192f5a0-1234-7abc-8def-0123456789ab'))).status()).toBe(404);
    expect((await page.request.get(commentUrl('0192f5a0-1234-7abc-8def-0123456789ab', seed.comments.first))).status()).toBe(404);
    expect((await page.request.get(commentUrl(seed.posts.thread, 'not-a-comment'))).status()).toBe(404);
    // The endpoint of the forms has no page of its own.
    expect((await page.request.get(`/post/${seed.posts.thread}/comments`, { maxRedirects: 0 })).status()).toBe(307);
  });

  test('a deleted comment and a removed one are tombstones: their text is not in the page, their replies stay', async ({ page }) => {
    const { status, text } = await html(page, postUrl(seed.posts.tombstones));
    expect(status).toBe(200);
    expect(text).not.toContain('Deleted text');
    expect(text).not.toContain('Removed text');
    expect(text).not.toContain('Rule 3');
    expect(text).toContain('[deleted]');
    expect(text).toContain('[removed by a moderator]');
    expect(text).toContain('Reply under deleted');
    expect(text).toContain('Reply under removed');
    await gotoHydrated(page, postUrl(seed.posts.tombstones));
    await expectAccessible(page);
  });

  test('under a post a moderator removed, the comments are not sent to anyone but the moderators', async ({ page }) => {
    const { status, text } = await html(page, postUrl(seed.posts.removed));
    expect(status).toBe(200);
    expect(text).toContain('Removed by a moderator');
    expect(text).not.toContain('Under a removed post');
    expect(text).not.toContain('Sort comments by');
    expect((await page.request.get(`/post/${seed.posts.removed}/comments/${seed.comments.first}`)).status()).toBe(404);
  });

  test('a locked post says so and offers no reply bar', async ({ page }) => {
    await gotoHydrated(page, postUrl(seed.posts.locked));
    await expect(page.getByText('This post is locked. It takes no new comments.').last()).toBeVisible();
    await expect(page.getByText(`Comment on locked ${seed.suffix}`)).toBeVisible();
  });

  test('the form endpoint refuses cross-site posts, and a signed-out post goes to sign-in', async ({ page }) => {
    const target = `/post/${seed.posts.thread}/comments`;
    const cross = await page.request.post(target, {
      form: { intent: 'reply', body: 'hi' },
      headers: { origin: 'https://evil.example' },
      maxRedirects: 0,
    });
    expect(cross.status()).toBe(403);
    const anonymous = await page.request.post(target, { form: { intent: 'reply', body: 'hi' }, maxRedirects: 0 });
    expect([anonymous.status(), anonymous.headers().location]).toEqual([
      303,
      `${postUrl(seed.posts.thread)}?commentError=auth.required#comments`,
    ]);
  });

  test('an address that is not a post id never becomes the redirect', async ({ page }) => {
    // The id in the address decodes to a protocol-relative URL; the answer must stay on this site.
    const response = await page.request.post('/post/%2F%2Fevil.example/comments', {
      form: { intent: 'reply', body: 'hi' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/?commentError=auth.required#comments');
  });
});

test.describe('a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('the thread speaks German, with no axe violations', async ({ page }) => {
    await gotoHydrated(page, postUrl(seed.posts.thread));
    await expect(page.getByRole('heading', { level: 2, name: 'Kommentare' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Kommentare sortieren nach' })).toBeVisible();
    await expect(page.getByText('Melde dich an, um zu kommentieren.')).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe('a 500-comment thread that reaches level 50', () => {
  test('is sent down to the depth the page draws and rendered in under 200 ms', async ({ page }) => {
    const path = postUrl(seed.posts.big);
    // Anonymous, so the request context is enough. The first request warms the server.
    await page.request.get(path);
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const response = await page.request.get(path);
      await response.body();
      times.push(performance.now() - started);
      expect(response.status()).toBe(200);
    }
    const best = Math.min(...times);
    expect(best, `best of ${times.length}: ${times.map((time) => time.toFixed(0)).join(', ')} ms`).toBeLessThan(200);

    await gotoHydrated(page, path);
    const shown = await page.locator('.pb-comment').count();
    // A page of top-level comments and the first replies under them; the rest is a "continue" or a "more" away.
    expect(shown).toBeGreaterThan(25);
    expect(shown).toBeLessThanOrEqual(300);
    await expect(page.getByRole('link', { name: 'More comments' })).toBeVisible();
    // Oldest first starts down the chain the seed makes: the page draws six levels of it and continues.
    await gotoHydrated(page, `${path}?sort=old`);
    const deepest = await page.locator('.pb-comment').evaluateAll((items) =>
      Math.max(
        ...items.map((item) => {
          let depth = 0;
          for (let node = item.parentElement; node; node = node.parentElement) if (node.classList.contains('pb-comment')) depth++;
          return depth;
        }),
      ),
    );
    expect(deepest).toBe(5);
    await expect(page.getByRole('link', { name: 'Continue this thread' }).first()).toBeVisible();
  });
});

test.describe('a signed-in person', () => {
  test('replies to a comment through the docked bar, hydrated; "post instead" sends the next one to the post', async ({ page }) => {
    await signedIn(page, seed.replier.name);
    await gotoHydrated(page, postUrl(seed.posts.thread));
    const bar = page.getByRole('form', { name: 'Reply' });
    const text = bar.getByRole('textbox', { name: 'Reply' });
    await expect(bar).toBeVisible();
    await expect(bar.getByText('Replying to')).toHaveCount(0);

    await page
      .locator(`#comment-${seed.comments.third} > .pb-comment__main > .pb-comment__actions`)
      .getByRole('button', { name: 'reply' })
      .click();
    await expect(bar.getByText('Replying to')).toBeVisible();
    await expect(bar).toContainText(`@${seed.replier.name}`);
    await expect(bar).toContainText(`Third comment ${seed.suffix}`);
    await expect(text).toBeFocused();
    await text.fill(`A reply to the third ${seed.suffix}`);
    await bar.getByRole('button', { name: 'Reply', exact: true }).click();
    const under = page.locator(`#comment-${seed.comments.third}`);
    await expect(under.getByText(`A reply to the third ${seed.suffix}`)).toBeVisible();
    await expect(page.getByRole('link', { name: '12 comments' })).toBeVisible();
    await expect(text).toHaveValue('');
    // The author's own upvote: a comment starts at a score of 1.
    await expect(under.locator('li .pb-vote__score').first()).toHaveText('1');

    // A second reply goes to the post: top level, after "post instead".
    await page
      .locator(`#comment-${seed.comments.first} > .pb-comment__main > .pb-comment__actions`)
      .getByRole('button', { name: 'reply' })
      .click();
    await bar.getByRole('button', { name: 'post instead' }).click();
    await expect(bar.getByText('Replying to')).toHaveCount(0);
    await text.fill(`A top-level comment ${seed.suffix}`);
    await bar.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByRole('link', { name: '13 comments' })).toBeVisible();
    expect(await topLevel(page)).toContain(`A top-level comment ${seed.suffix}`);
    await expectAccessible(page);
  });

  test('votes on a comment, and the server keeps it', async ({ page }) => {
    await signedIn(page, seed.replier.name);
    await gotoHydrated(page, postUrl(seed.posts.thread));
    const second = page.locator(`#comment-${seed.comments.second} > .pb-comment__main > .pb-comment__actions`);
    const score = second.locator('.pb-vote__score');
    await expect(score).toHaveText('3');
    const answered = () => page.waitForResponse((response) => response.url().includes('/_serverFn/'));
    const voted = answered();
    await second.getByRole('button', { name: 'Upvote' }).click();
    await voted;
    await expect(score).toHaveText('4');
    await page.reload();
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(score).toHaveText('4');
    await expect(second.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
  });

  test("a reply being typed and a vote stay on their comment's page when the router opens another", async ({ page }) => {
    await signedIn(page, seed.author.name);
    await gotoHydrated(page, postUrl(seed.posts.thread));
    await page.evaluate(() => Object.assign(window, { loadedOnce: true }));
    // Both links go through the router, which reuses the permalink page's component.
    await page.getByRole('link', { name: 'Continue this thread' }).first().click();
    await page.waitForURL(commentUrl(seed.posts.thread, seed.comments.chain[5]!));
    // The address changes before the page does; the permalink page is the one with its own title.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Comment on');
    const actions = (id: string) => page.locator(`#comment-${id} > .pb-comment__main > .pb-comment__actions`);
    const voted = page.waitForResponse((response) => response.url().includes('/_serverFn/'));
    await actions(seed.comments.chain[5]!).getByRole('button', { name: 'Upvote' }).click();
    await voted;
    await expect(actions(seed.comments.chain[5]!).getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('textbox', { name: 'Reply' }).fill(`Draft for level 6 ${seed.suffix}`);

    await page.getByRole('link', { name: 'View the comment above' }).click();
    await page.waitForURL(commentUrl(seed.posts.thread, seed.comments.chain[4]!));
    expect(await page.evaluate(() => 'loadedOnce' in window)).toBe(true);
    // Nothing typed there is here, and the bar answers this page's comment.
    const bar = page.getByRole('form', { name: 'Reply' });
    await expect(bar.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
    await expect(bar).toContainText(`Chain level 5 ${seed.suffix}`);
    // The votes are the server's: the comment voted on is a reply here, and this page's own comment is not voted.
    await expect(actions(seed.comments.chain[5]!).getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
    await expect(actions(seed.comments.chain[4]!).getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('replies without JavaScript: a plain form post, then the page again at the new comment', async ({ browser }) => {
    const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    await page.goto('/auth/sign-in');
    await signIn(page, `@${seed.replier.name}`, seed.password);
    await page.waitForURL('/');
    await page.goto(postUrl(seed.posts.thread));
    await page.getByRole('textbox', { name: 'Reply' }).fill(`No script ${seed.suffix}`);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${seed.posts.thread}#comment-[0-9a-f-]+$`));
    await expect(page.getByText(`No script ${seed.suffix}`)).toBeVisible();

    // On a comment's own page the bar answers that comment, with no script either.
    await page.goto(commentUrl(seed.posts.thread, seed.comments.first));
    await expect(page.getByText('Replying to')).toBeVisible();
    await page.getByRole('textbox', { name: 'Reply' }).fill(`Under the first ${seed.suffix}`);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${commentUrl(seed.posts.thread, seed.comments.first)}#comment-[0-9a-f-]+$`));
    const list = page.locator(`#comment-${seed.comments.first}`);
    await expect(list.getByText(`Under the first ${seed.suffix}`)).toBeVisible();

    // A refusal comes back as a message beside the bar, and the URL says why.
    await page.getByRole('textbox', { name: 'Reply' }).fill('   ');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page).toHaveURL(`${commentUrl(seed.posts.thread, seed.comments.first)}?commentError=invalid#comments`);
    await expect(page.getByRole('alert')).toHaveText('Write something, up to 10,000 characters.');
    await page.close();
  });

  test('is refused with the exact reason: a locked post, a blank body, an unverified email, a reply to a missing comment', async ({
    page,
    browser,
  }) => {
    await signedIn(page, seed.replier.name);
    await gotoHydrated(page, postUrl(seed.posts.thread));
    // A locked post offers a signed-in person no bar, and the server refuses the post all the same.
    await gotoHydrated(page, postUrl(seed.posts.locked));
    await expect(page.getByRole('form', { name: 'Reply' })).toHaveCount(0);
    await expect(page.locator('#comments').getByText('This post is locked. It takes no new comments.')).toBeVisible();
    expect(await post(page, seed.posts.locked, { intent: 'reply', body: 'hello' })).toEqual({
      status: 400,
      answer: { error: 'post.locked' },
    });
    expect(await post(page, seed.posts.thread, { intent: 'reply', body: '   ' })).toEqual({ status: 400, answer: { error: 'invalid' } });
    expect(await post(page, seed.posts.thread, { intent: 'reply', body: 'x'.repeat(10_001) })).toEqual({
      status: 400,
      answer: { error: 'invalid' },
    });
    expect(await post(page, seed.posts.thread, { intent: 'reply', body: 'hello', parent: '0192f5a0-1234-7abc-8def-0123456789ab' })).toEqual(
      {
        status: 400,
        answer: { error: 'target.not_found' },
      },
    );
    expect(await post(page, seed.posts.thread, { intent: 'reply', body: 'hello', parent: seed.comments.deleted })).toEqual({
      status: 400,
      answer: { error: 'target.not_found' },
    });
    expect(await post(page, seed.posts.tombstones, { intent: 'reply', body: 'hello', parent: seed.comments.deleted })).toEqual({
      status: 400,
      answer: { error: 'target.deleted' },
    });
    expect(await post(page, seed.posts.tombstones, { intent: 'reply', body: 'hello', parent: seed.comments.removed })).toEqual({
      status: 400,
      answer: { error: 'target.removed' },
    });
    expect(await post(page, seed.posts.thread, { intent: 'edit', body: 'mine now', comment: seed.comments.second })).toEqual({
      status: 400,
      answer: { error: 'comment.author_required' },
    });

    const other = await (await browser.newContext()).newPage();
    await signedIn(other, seed.unverified.name);
    await gotoHydrated(other, postUrl(seed.posts.thread));
    await expect(other.getByText('Verify your email address to comment.').first()).toBeVisible();
    expect(await post(other, seed.posts.thread, { intent: 'reply', body: 'hello' })).toEqual({
      status: 400,
      answer: { error: 'auth.email_unverified' },
    });
    await other.close();
  });

  test('edits and deletes their own comment on its page, with a plain form; nobody else gets the forms', async ({ page, browser }) => {
    await signedIn(page, seed.replier.name);
    await gotoHydrated(page, postUrl(seed.posts.empty));
    const created = await post(page, seed.posts.empty, { intent: 'reply', body: `Mine to change ${seed.suffix}` });
    expect(created.status).toBe(200);
    const id = created.answer.id!;
    await gotoHydrated(page, commentUrl(seed.posts.empty, id));
    const own = page.getByRole('group', { name: 'Your comment' });
    await own.getByText('Edit', { exact: true }).click();
    await own.getByRole('textbox', { name: 'Edit your comment' }).fill(`Changed **text** ${seed.suffix}`);
    await own.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(new RegExp(`${commentUrl(seed.posts.empty, id)}$`));
    await expect(page.locator(`#comment-${id}`).locator('strong')).toHaveText('text');
    await expect(page.locator(`#comment-${id}`)).toContainText('edited');

    const stranger = await (await browser.newContext()).newPage();
    await signedIn(stranger, seed.author.name);
    await gotoHydrated(stranger, commentUrl(seed.posts.empty, id));
    await expect(stranger.getByRole('group', { name: 'Your comment' })).toHaveCount(0);
    await stranger.close();

    await page.getByRole('group', { name: 'Your comment' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator(`#comment-${id}`)).toContainText('[deleted]');
    await expect(page.locator(`#comment-${id}`)).not.toContainText('Changed');
    await expect(page.getByRole('group', { name: 'Your comment' })).toHaveCount(0);
  });
});

test.describe('an account over its budget', () => {
  test('is refused with rate.limited (429) after 30 comment forms in ten minutes, and the others are not', async ({ page, browser }) => {
    await signedIn(page, seed.moderator.name);
    await gotoHydrated(page, postUrl(seed.posts.locked));
    // Refused by the lock each time, but every post counts.
    for (let count = 1; count <= 30; count++)
      expect(await post(page, seed.posts.locked, { intent: 'reply', body: 'hello' })).toEqual({
        status: 400,
        answer: { error: 'post.locked' },
      });
    expect(await post(page, seed.posts.locked, { intent: 'reply', body: 'hello' })).toEqual({
      status: 429,
      answer: { error: 'rate.limited' },
    });

    // Another account has its own budget.
    const other = await (await browser.newContext()).newPage();
    await signedIn(other, seed.author.name);
    await gotoHydrated(other, postUrl(seed.posts.locked));
    expect(await post(other, seed.posts.locked, { intent: 'reply', body: 'hello' })).toEqual({
      status: 400,
      answer: { error: 'post.locked' },
    });
    await other.close();
  });
});

test.describe('a moderator', () => {
  test('sees why a comment was removed; nobody else does', async ({ page, browser }) => {
    await signedIn(page, seed.moderator.name);
    await gotoHydrated(page, postUrl(seed.posts.tombstones));
    const removed = page.locator('details.cm-removed');
    await expect(removed).toContainText('Removed by moderators (1)');
    await removed.getByText('Removed by moderators (1)').click();
    await expect(removed).toContainText('Rule 3: no ads');
    await expectAccessible(page);
    await gotoHydrated(page, postUrl(seed.posts.removed));
    await expect(page.getByText(`Under a removed post ${seed.suffix}`)).toBeVisible();

    const reader = await (await browser.newContext()).newPage();
    await signedIn(reader, seed.replier.name);
    expect((await html(reader, postUrl(seed.posts.tombstones))).text).not.toContain('Rule 3');
    await reader.close();
  });
});
