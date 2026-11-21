import { expect, test, type Page } from '@playwright/test';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The inbox's gallery pages (packages/web/src/routes/kit/-inbox.tsx): every kind of notice as the inbox
// draws it, and the inline reply in each state, through the shared state helper in light and dark, under
// forced colours and reduced motion and at a phone's width, whatever brand pack site.brand names. The
// row's forms post to the real endpoints; the reply cases answer for them here, so no database is needed.
test.beforeEach(async ({ request }) => skipWithoutKit(request));

const notices = ['inbox-replies', 'inbox-mentions', 'inbox-moderation', 'inbox-account'];
const compositions: Record<string, string[]> = {
  ...Object.fromEntries(notices.map((key) => [key, ['rest', 'hover', 'focus', 'pressed']])),
  'inbox-reply': ['rest', 'selected', 'pending', 'invalid', 'hover', 'focus', 'pressed'],
};

for (const [composition, states] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    // A link inside a line of text (a title, a statement) is held to WCAG's 24px; the row's buttons to 44 below.
    expect(stateProblems(checks, { target: 24 })).toEqual([]);
  });
}

const rows = (page: Page) => page.getByRole('list', { name: 'Notices' }).getByRole('listitem');
/** The first reply notice's row on /kit/inbox-replies, from @jun. */
const first = (page: Page) => rows(page).first();

test('every kind of notice has a row, and unread is said in words as well as drawn', async ({ page }) => {
  const kinds = new Set<string | null>();
  for (const key of notices) {
    await gotoHydrated(page, `/kit/${key}`);
    for (const kind of await rows(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kind')))) kinds.add(kind);
  }
  expect(kinds).toEqual(new Set(['reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban']));

  await gotoHydrated(page, '/kit/inbox-replies');

  const unread = rows(page).and(page.locator(':not([data-read])'));
  const read = rows(page).and(page.locator('[data-read]'));
  expect(await unread.count()).toBeGreaterThan(0);
  expect(await read.count()).toBeGreaterThan(0);
  // Assistive technology hears "Unread" first on an unread row, and never on a read one.
  for (const row of await unread.all()) await expect(row.locator('.pb-notice__title')).toContainText(/^Unread @?/);
  for (const row of await read.all()) await expect(row).not.toContainText('Unread');
  // The dot is drawn only (a border, so forced colours keep it), and a read row has none.
  const dot = (row: ReturnType<typeof rows>) =>
    row
      .locator('.pb-notice__dot')
      .evaluate((node) => ({ hidden: node.getAttribute('aria-hidden'), width: getComputedStyle(node).borderTopWidth }));
  expect(await dot(unread.first())).toEqual({ hidden: 'true', width: expect.not.stringMatching(/^0px$/) });
  expect((await dot(read.first())).width).toBe('0px');
});

test('under forced colours the unread dot is still drawn', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, forcedColors: 'active' });
  const page = await context.newPage();
  await gotoHydrated(page, '/kit/inbox-replies');
  const dot = rows(page).and(page.locator(':not([data-read])')).first().locator('.pb-notice__dot');
  const drawn = await dot.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.borderTopWidth, style: style.borderTopStyle, colour: style.borderTopColor };
  });
  expect(drawn.style).toBe('solid');
  expect(drawn.width).not.toBe('0px');
  expect(drawn.colour).not.toBe('rgba(0, 0, 0, 0)');
  await context.close();
});

test('on a phone every button a notice holds, and its reply, is a 44px target', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{ ...prefsCookie('card', 'light'), url: baseURL! }]);
  for (const path of [...notices.map((key) => `/kit/${key}`), '/kit/inbox-reply']) {
    await gotoHydrated(page, path);
    const sides = await page
      .locator('.pb-notice__actions')
      .locator('button, a')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect()).map(({ width, height }) => Math.round(Math.min(width, height))),
      );
    expect(sides.length, path).toBeGreaterThan(0);
    expect(
      sides.filter((side) => side < 44),
      path,
    ).toEqual([]);
  }
});

test('Reply opens a field in place that takes focus, and Escape closes it back to Reply', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-replies');
  const reply = first(page).getByRole('button', { name: /^Reply: @jun@lemmy\.world, / });
  await expect(reply).toHaveAttribute('aria-expanded', 'false');
  await reply.click();
  await expect(reply).toHaveAttribute('aria-expanded', 'true');
  const field = first(page).getByRole('textbox', { name: 'Reply to @jun@lemmy.world' });
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(reply).toBeFocused();
  // What was typed stays while the row does.
  await reply.click();
  await field.fill('Half a thought');
  await first(page).getByRole('button', { name: 'Cancel' }).click();
  await reply.click();
  await expect(field).toHaveValue('Half a thought');
});

test('the reply posts through the comment form; a refusal and a lost connection keep the text', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-replies');
  const sent: URLSearchParams[] = [];
  const answers: ({ status: number; json: unknown } | 'abort')[] = [
    { status: 400, json: { error: 'post.locked' } },
    'abort',
    { status: 200, json: { ok: true, id: '00000000-0000-7000-8000-000000000400' } },
  ];
  await page.route('**/post/*/comments', async (route) => {
    sent.push(new URLSearchParams(route.request().postData() ?? ''));
    const answer = answers[sent.length - 1]!;
    await (answer === 'abort' ? route.abort() : route.fulfill(answer));
  });
  const marked: string[] = [];
  await page.route('**/notifications?*', async (route) => {
    marked.push(new URL(route.request().url()).search);
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await first(page)
    .getByRole('button', { name: /^Reply: / })
    .click();
  const field = first(page).getByRole('textbox', { name: 'Reply to @jun@lemmy.world' });
  await field.fill('From life, at the kitchen table.');
  await field.press('Control+Enter');
  await expect(first(page).getByText('This post is locked. It takes no new comments.')).toBeVisible();
  await expect(field).toHaveValue('From life, at the kitchen table.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(Object.fromEntries(sent[0]!)).toEqual({
    intent: 'reply',
    parent: '00000000-0000-7000-8000-000000000200',
    body: 'From life, at the kitchen table.',
  });

  await first(page).getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(first(page).getByText('The request did not get through. Check your connection and try again.')).toBeVisible();
  await expect(field).toHaveValue('From life, at the kitchen table.');

  await first(page).getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(first(page).getByRole('status')).toHaveText('Reply posted. View reply');
  await expect(first(page).getByRole('link', { name: 'View reply' })).toHaveAttribute(
    'href',
    '/post/00000000-0000-7000-8000-000000000100/comments/00000000-0000-7000-8000-000000000400',
  );
  await expect(field).toHaveCount(0);
  await expect(first(page).getByRole('button', { name: /^Reply: / })).toBeFocused();
  // An unread notice answered is marked read, through the inbox's own form.
  expect(marked).toEqual(['?intent=read&id=00000000-0000-7000-8000-000000000001']);
});

test('without scripts Reply is a link to the comment, whose page has the reply form', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/kit/inbox-replies');
  await expect(first(page).getByRole('link', { name: /^Reply: @jun@lemmy\.world, / })).toHaveAttribute(
    'href',
    '/post/00000000-0000-7000-8000-000000000100/comments/00000000-0000-7000-8000-000000000200',
  );
  await expect(first(page).getByRole('button', { name: /^Reply: / })).toHaveCount(0);
  await context.close();
});
