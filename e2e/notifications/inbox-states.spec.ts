import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The inbox's gallery pages (packages/web/src/routes/kit/-inbox.tsx): every kind of notice as the inbox
// draws it, and the inline reply in each state, through the shared state helper in light and dark, under
// forced colours and reduced motion and at a phone's width, whatever brand pack site.brand names. The
// row's forms post to the real endpoints; the reply cases answer for them here, so no database is needed.
// Branch 5 (lane f-notify) adds the followed thread's and the accepted follow's rows, the date groups,
// Mark all read's status row with its Undo, and the post's Follow thread bell and rail switch.
test.beforeEach(async ({ request }) => skipWithoutKit(request));

const notices = ['inbox-replies', 'inbox-mentions', 'inbox-moderation', 'inbox-account', 'inbox-follows'];
const compositions: Record<string, string[]> = {
  ...Object.fromEntries([...notices, 'inbox-groups'].map((key) => [key, ['rest', 'hover', 'focus', 'pressed']])),
  'inbox-reply': ['rest', 'selected', 'pending', 'invalid', 'hover', 'focus', 'pressed'],
  'inbox-undo': ['rest', 'pending', 'hover', 'focus', 'pressed'],
  'thread-follow': ['rest', 'selected', 'pending', 'hover', 'focus', 'pressed'],
};
/**
 * The smallest target each page may hold on a phone. A link inside a line of text (a title, a statement)
 * is held to WCAG's 24px, the rows' buttons to 44 below; Undo and the bell are 44 themselves.
 */
const floor = (composition: string) => (composition === 'inbox-undo' || composition === 'thread-follow' ? 44 : 24);

for (const [composition, states] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target: floor(composition) })).toEqual([]);
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
  expect(kinds).toEqual(new Set(['reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban', 'thread_reply', 'follow_accept']));

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

test('two submits before the page draws again send one reply', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-replies');
  let sent = 0;
  await page.route('**/post/*/comments', (route) => {
    sent += 1;
    return route.fulfill({ status: 200, json: { ok: true, id: '00000000-0000-7000-8000-000000000400' } });
  });
  await page.route('**/notifications?*', (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await first(page)
    .getByRole('button', { name: /^Reply: / })
    .click();
  await first(page).getByRole('textbox', { name: 'Reply to @jun@lemmy.world' }).fill('Only once.');
  // Both in one task, so React has not drawn the first one's pending state when the second comes.
  await first(page)
    .locator('form.pb-notice__reply')
    .evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
  await expect(first(page).getByRole('status')).toHaveText('Reply posted. View reply');
  await page.waitForTimeout(200);
  expect(sent).toBe(1);
});

test('a reply is sent once: Send stays held until the notice is marked read as well', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-replies');
  const sent: string[] = [];
  await page.route('**/post/*/comments', async (route) => {
    sent.push(new URLSearchParams(route.request().postData() ?? '').get('body') ?? '');
    await route.fulfill({ status: 200, json: { ok: true, id: '00000000-0000-7000-8000-000000000400' } });
  });
  // The comment is saved at once; the notice's mark-read answers only when released.
  let marking!: () => void;
  const marked = new Promise<void>((resolve) => (marking = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/notifications?*', async (route) => {
    marking();
    await released;
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await first(page)
    .getByRole('button', { name: /^Reply: / })
    .click();
  const field = first(page).getByRole('textbox', { name: 'Reply to @jun@lemmy.world' });
  await field.fill('Once is enough.');
  const send = first(page).getByRole('button', { name: 'Reply', exact: true });
  await send.click();
  await marked;
  // Saved, not yet marked read: a second press, Ctrl+Enter or more typing sends and clears nothing.
  await send.click({ force: true });
  await field.press('Control+Enter');
  await field.pressSequentially(' More.');
  await expect(field).toHaveValue('Once is enough.');
  expect(sent).toEqual(['Once is enough.']);
  release();
  await expect(first(page).getByRole('status')).toHaveText('Reply posted. View reply');
  await expect(field).toHaveCount(0);
  expect(sent).toEqual(['Once is enough.']);
});

test('a reply sent once the reader has moved on leaves focus where they went', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-replies');
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/post/*/comments', async (route) => {
    await released;
    await route.fulfill({ status: 200, json: { ok: true, id: '00000000-0000-7000-8000-000000000400' } });
  });
  await page.route('**/notifications?*', (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await first(page)
    .getByRole('button', { name: /^Reply: / })
    .click();
  await first(page).getByRole('textbox', { name: 'Reply to @jun@lemmy.world' }).fill('Sent while I read on.');
  await first(page).getByRole('button', { name: 'Reply', exact: true }).click();
  const elsewhere = rows(page)
    .nth(1)
    .getByRole('button', { name: /^Mark unread/ });
  await elsewhere.focus();
  release();
  await expect(first(page).getByRole('status')).toHaveText('Reply posted. View reply');
  await expect(elsewhere).toBeFocused();
});

test('a reply whose field closes as the reader moves on leaves focus where they went', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-replies');
  await page.route('**/post/*/comments', (route) =>
    route.fulfill({ status: 200, json: { ok: true, id: '00000000-0000-7000-8000-000000000400' } }),
  );
  await page.route('**/notifications?*', (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await first(page)
    .getByRole('button', { name: /^Reply: / })
    .click();
  await first(page).getByRole('textbox', { name: 'Reply to @jun@lemmy.world' }).fill('Sent as I move on.');
  // The moment the sent reply's field leaves the page, before the next frame, focus moves to the next row (a Tab would).
  await page.evaluate(() => {
    const [row, next] = document.querySelectorAll('[aria-label="Notices"] > li');
    const observer = new MutationObserver(() => {
      if (row!.querySelector('textarea')) return;
      observer.disconnect();
      next!.querySelector<HTMLElement>('form[data-toggle] button')!.focus();
    });
    observer.observe(row!, { childList: true, subtree: true });
  });
  await first(page).getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(first(page).getByRole('status')).toHaveText('Reply posted. View reply');
  await page.waitForTimeout(100);
  await expect(
    rows(page)
      .nth(1)
      .getByRole('button', { name: /^Mark (un)?read/ }),
  ).toBeFocused();
});

test('a sensitive notice offers no reply in place: Reply leads to the thread, whose gate applies', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-mentions');
  // The ordinary mention still answers in place.
  const mention = rows(page).first();
  await expect(mention.getByRole('button', { name: /^Reply: @kofi@fedia\.io, / })).toHaveAttribute('aria-expanded', 'false');
  const sensitive = rows(page).filter({ hasText: 'Sensitive content' });
  await expect(sensitive).toHaveCount(1);
  await expect(sensitive.getByRole('button', { name: /^Reply: / })).toHaveCount(0);
  await expect(sensitive.getByRole('link', { name: /^Reply: @kofi@fedia\.io, / })).toHaveAttribute(
    'href',
    '/post/00000000-0000-7000-8000-000000000100/comments/00000000-0000-7000-8000-000000000200',
  );
  await expect(sensitive.getByRole('textbox')).toHaveCount(0);
  await expect(sensitive.getByRole('status')).toHaveCount(0);
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

test('the new kinds read as the mock words them, with no moderator badge on an accepted follow', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-follows');
  const [followed, withheld, accepted] = [0, 1, 2].map((n) => rows(page).nth(n));
  await expect(followed).toContainText('@mira commented in a thread you follow');
  await expect(followed.getByRole('button', { name: /^Reply: @mira, / })).toBeVisible();
  // A followed thread's comment removed since: nobody is named, and it cannot be answered.
  await expect(withheld.locator('.pb-notice__title')).toContainText('Someone commented in a thread you follow');
  await expect(withheld.getByRole('button', { name: /^Reply/ })).toHaveCount(0);
  await expect(accepted).toContainText('!art accepted your request to join');
  await expect(accepted.getByText('MOD', { exact: true })).toHaveCount(0);
  await expect(accepted.getByRole('link', { name: 'Open community' })).toHaveAttribute('href', /^\/c\/art/);
  // A removal names the published review address and the decision.
  await gotoHydrated(page, '/kit/inbox-moderation');
  await expect(rows(page).first().getByRole('link', { name: 'Ask for a review' })).toHaveAttribute(
    'href',
    'mailto:review@example.test?subject=Review%20of%20moderation%20decision%2000000000-0000-7000-8000-000000000300',
  );
  await expect(rows(page).nth(1).getByRole('link', { name: 'Ask for a review' })).toHaveCount(0);
});

test('the date groups head their rows, newest first', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-groups');
  await expect(page.locator('[data-kit-sample]').getByRole('heading', { level: 2 })).toHaveText([
    'Today',
    'Yesterday',
    'This week',
    'Earlier',
  ]);
  for (const group of ['Today', 'Yesterday', 'This week', 'Earlier'])
    await expect(page.getByRole('list', { name: `Notices, ${group}` }).getByRole('listitem')).toHaveCount(1);
});

test('Undo is named for what it undoes, and its status row speaks', async ({ page }) => {
  await gotoHydrated(page, '/kit/inbox-undo');
  const rest = page.locator('[data-kit-state="rest"]');
  await expect(rest.getByRole('button', { name: 'Undo: mark the 3 unread again' })).toHaveText('Undo');
  await expect(rest.getByRole('status')).toHaveText(['Marked 3 notices as read.Undo', '3 notices are unread again.']);
  await expect(page.locator('[data-kit-state="pending"]').getByRole('button', { name: /^Undo/ })).toHaveAttribute('aria-busy', 'true');
});

test('the bell is one toggle named Follow thread whose pressed state and shape change, not only its colour', async ({ page }) => {
  await gotoHydrated(page, '/kit/thread-follow');
  const bell = (state: string) => page.locator(`[data-kit-state="${state}"]`).getByRole('button', { name: 'Follow thread', exact: true });
  await expect(bell('rest')).toHaveAttribute('aria-pressed', 'false');
  await expect(bell('selected')).toHaveAttribute('aria-pressed', 'true');
  const shape = async (state: string) => bell(state).locator('svg').first().getAttribute('class');
  expect(await shape('rest')).not.toEqual(await shape('selected'));
  // Without scripts it is a form: off it posts a follow, on an unfollow, to the inbox's endpoint.
  await expect(page.locator('[data-kit-state="rest"] form')).toHaveAttribute(
    'action',
    '/notifications?intent=watch&post=00000000-0000-7000-8000-000000000100',
  );
  await expect(page.locator('[data-kit-state="selected"] form')).toHaveAttribute(
    'action',
    '/notifications?intent=unwatch&post=00000000-0000-7000-8000-000000000100',
  );
  await gotoHydrated(page, '/kit/thread-follow-rail');
  const toggle = (state: string) => page.locator(`[data-kit-state="${state}"]`).getByRole('switch', { name: 'Follow thread' });
  await expect(toggle('rest')).not.toBeChecked();
  await expect(toggle('selected')).toBeChecked();
});

// The rail's switch: the helper drives hover, focus and press on a sample's first control, which for Mux's Switch
// is its visually hidden native input, so its states are checked here instead: off, on and on its way, in light,
// dark and forced colours, by axe; and on and off from the keyboard on the post page (follows.spec.ts). The rail
// is not on a phone (the frame hides it below 62rem), so it has no phone target.
for (const [scheme, forcedColors] of [
  ['light', 'none'],
  ['dark', 'none'],
  ['light', 'active'],
] as const) {
  test(`/kit/thread-follow-rail in ${scheme}${forcedColors === 'active' ? ' under forced colours' : ''}: off, on and pending pass axe`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, colorScheme: scheme, forcedColors });
    await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL! }]);
    const page = await context.newPage();
    await gotoHydrated(page, '/kit/thread-follow-rail');
    const toggle = (state: string) => page.locator(`[data-kit-state="${state}"]`).getByRole('switch', { name: 'Follow thread' });
    await expect(toggle('rest')).not.toBeChecked();
    await expect(toggle('selected')).toBeChecked();
    await expect(toggle('pending')).toHaveAttribute('aria-readonly', 'true');
    const axe = await new AxeBuilder({ page })
      .include('[data-kit-state]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(axe.violations.map(({ id }) => id)).toEqual([]);
    await context.close();
  });
}
