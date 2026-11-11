import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { choose, chooseType, seed as seedComposer, signedIn as composerSession } from '../composer/support.ts';
import { seedWorld, signedIn, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// The app's own field wrappers (packages/ui text-field, text-area, checkbox, select) on real
// pages: once React Aria has taken over the browser's validation bubble, a field the browser
// refuses explains itself in the page's language, as an alert that is also the control's
// accessible description, and the message goes once the value is fixed. A caller's own message
// (the composer's check) is linked and announced the same way. Without JavaScript the browser
// validates as it always has. Nothing here sends a valid form: the pages are only read.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seeds (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

const messages = {
  'en-US': {
    required: 'Fill in this field.',
    requiredCheck: 'Tick this box to continue.',
    requiredChoice: 'Choose an option.',
    tooLong: 'Use at most 10,000 characters.',
    composerUrl: 'Enter a full web address that starts with http:// or https://.',
  },
  'de-DE': {
    required: 'Fülle dieses Feld aus.',
    requiredCheck: 'Setze hier ein Häkchen, um fortzufahren.',
    requiredChoice: 'Wähle eine Option aus.',
    tooLong: 'Verwende höchstens 10.000 Zeichen.',
    composerUrl: 'Gib eine vollständige Webadresse ein, die mit http:// oder https:// beginnt.',
  },
} as const;
type Locale = keyof typeof messages;
type State = Awaited<ReturnType<ReturnType<Page['context']>['storageState']>>;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Counts the posts a page sends (form posts and fetches alike), so a test can show one was stopped. */
function posts(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') count++;
  });
  return () => count;
}

/** The control is invalid and has focus, and `message` is an alert on the page that is also the control's accessible description. */
async function expectExplained(page: Page, control: Locator, message: string, { focused = true } = {}): Promise<void> {
  if (focused) await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(1);
  await expect(control).toHaveAccessibleDescription(new RegExp(escape(message)));
}

/** The message is gone: no alert carries it, the control no longer describes itself with it, and it is no longer invalid. */
async function expectCleared(page: Page, control: Locator, message: string): Promise<void> {
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  await expect(control).not.toHaveAccessibleDescription(new RegExp(escape(message)));
  await expect(control).not.toHaveAttribute('aria-invalid', 'true');
}

/** A page signed in as the session in `state`, in `locale`. */
async function pageAs(browser: Browser, state: State, locale: Locale) {
  const context = await browser.newContext({ storageState: state, locale, extraHTTPHeaders: { 'Accept-Language': locale } });
  return context.newPage();
}

/** Ticks a box from the keyboard: Mux draws it over a visually hidden input, and the terms label is mostly links. */
async function tick(box: Locator): Promise<void> {
  await box.focus();
  await box.press('Space');
}

/** Everything on sign-up filled and valid except what `leave` names, so that one is the only invalid field. */
async function fillSignUp(page: Page, leave: 'terms' | 'month'): Promise<void> {
  const field = (name: string) => page.locator(`form input[name="${name}"]`);
  await field('invite').fill('PB-2222-2222');
  await field('username').fill('someone');
  await field('email').fill('someone@example.test');
  await field('password').fill('a long enough passphrase');
  await field('day').fill('14');
  if (leave !== 'month') await page.locator('form select[name="month"]').selectOption('3');
  await field('year').fill('1994');
  if (leave !== 'terms') await tick(page.locator('form input[name="terms"]'));
}

let world: World;
let admin: State;
let moderator: State;
let member: State;
let poster: State;
let composerCommunity: string;

test.beforeAll(async ({ browser, baseURL }) => {
  world = seedWorld();
  const sessions = await Promise.all(
    [
      (page: Page) => signedInAdmin(page, world),
      (page: Page) => signedIn(page, world, world.moderator.name),
      (page: Page) => signedIn(page, world, world.bystander.name),
    ].map(async (signIn) => {
      const context = await browser.newContext();
      await signIn(await context.newPage());
      const state = await context.storageState();
      await context.close();
      return state;
    }),
  );
  [admin, moderator, member] = sessions as [State, State, State];
  const composer = seedComposer();
  composerCommunity = composer.communities.open.handle;
  const context = await composerSession(browser, baseURL!, composer.people.poster, composer.password);
  poster = await context.storageState();
  await context.close();
});

for (const locale of ['en-US', 'de-DE'] as const) {
  test.describe(locale, () => {
    const text = messages[locale];

    test('the modlog reason (text area) explains an empty and an over-long reason, then clears', async ({ browser }) => {
      const page = await pageAs(browser, moderator, locale);
      const log = recordConsole(page);
      const sent = posts(page);
      await gotoHydrated(page, `/post/${world.posts.author}`);
      const panel = page.locator(`#comment-${world.comments.spam}`).getByTestId('mod-panel-remove');
      await panel.getByRole('button', { expanded: false }).click();
      const reason = panel.locator('textarea[name="reason"]');
      const submit = panel.locator('button[type="submit"]');

      await submit.click();
      await expectExplained(page, reason, text.required);
      await reason.fill('Spam');
      await reason.blur();
      await expectCleared(page, reason, text.required);

      // Over the limit: a script puts in two characters past the limit (as React would see a
      // paste), then a person deletes one, which is the edit the browser judges: maxlength stops
      // typing past the limit, and only a person's edit makes a value too long.
      await reason.evaluate((area: HTMLTextAreaElement) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, 'x'.repeat(10_002));
        area.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await reason.press('End');
      await reason.press('Backspace');
      // Leaving the field commits the edit, which shows the message (React Aria's timing); a post
      // tried then is still stopped, with focus back on the field.
      await reason.blur();
      await expectExplained(page, reason, text.tooLong, { focused: false });
      await submit.click();
      await expectExplained(page, reason, text.tooLong);
      await reason.fill('Spam');
      await reason.blur();
      await expectCleared(page, reason, text.tooLong);
      expect(sent()).toBe(0);
      expect(log.problems()).toEqual([]);
      await page.context().close();
    });

    test('the peers domain (text field) explains an empty host, then clears', async ({ browser }) => {
      const page = await pageAs(browser, admin, locale);
      const log = recordConsole(page);
      const sent = posts(page);
      await gotoHydrated(page, '/admin/peers');
      const domain = page.locator('input[name="domain"]');
      await domain.locator('xpath=ancestor::form[1]').locator('button[type="submit"]').click();
      await expectExplained(page, domain, text.required);
      expect(sent()).toBe(0);
      await domain.fill('spam.example');
      await domain.blur();
      await expectCleared(page, domain, text.required);
      expect(log.problems()).toEqual([]);
      await page.context().close();
    });

    test('the blocks field explains an empty handle, then clears', async ({ browser }) => {
      const page = await pageAs(browser, member, locale);
      const sent = posts(page);
      await gotoHydrated(page, '/settings/blocks');
      const handle = page.locator('input[name="handle"]');
      // Enter in the field submits, as the button does.
      await handle.press('Enter');
      await expectExplained(page, handle, text.required);
      expect(sent()).toBe(0);
      await handle.fill('@nobody');
      await handle.blur();
      await expectCleared(page, handle, text.required);
      await page.context().close();
    });

    test('the composer’s own message for a malformed link is linked and announced, and goes with the edit', async ({ browser }) => {
      const page = await pageAs(browser, poster, locale);
      const sent = posts(page);
      await gotoHydrated(page, '/submit');
      await choose(page, composerCommunity);
      await chooseType(page, 'Link');
      const url = page.locator('input[name="url"]');
      await url.fill('not a link');
      await page.locator('form button[type="submit"]').click();
      // The composer checks on its own (noValidate) and leaves focus on its button.
      await expectExplained(page, url, text.composerUrl, { focused: false });
      expect(sent()).toBe(0);
      await url.fill('https://example.test/article');
      await expectCleared(page, url, text.composerUrl);
      await page.context().close();
    });

    test('sign-up explains the unticked terms box and the unchosen month, then clears each', async ({ browser }) => {
      const context = await browser.newContext({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });
      const page = await context.newPage();
      const log = recordConsole(page);
      const sent = posts(page);
      await gotoHydrated(page, '/auth/sign-up');
      const submit = page.locator('form button[type="submit"]');
      const terms = page.locator('form input[name="terms"]');
      await fillSignUp(page, 'terms');
      await submit.click();
      await expectExplained(page, terms, text.requiredCheck);
      await tick(terms);
      await expect(terms).toBeChecked();
      await expectCleared(page, terms, text.requiredCheck);

      await gotoHydrated(page, '/auth/sign-up');
      const month = page.locator('form select[name="month"]');
      await fillSignUp(page, 'month');
      await submit.click();
      await expectExplained(page, month, text.requiredChoice);
      await month.selectOption('3');
      await expectCleared(page, month, text.requiredChoice);
      expect(sent()).toBe(0);
      expect(log.problems()).toEqual([]);
      await context.close();
    });
  });
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the browser still stops an unticked terms box and an empty handle, with no app message', async ({ page, browser }) => {
    const sent = posts(page);
    await page.goto('/auth/sign-up');
    await fillSignUp(page, 'terms');
    const terms = page.locator('form input[name="terms"]');
    await page.locator('form button[type="submit"]').click();
    expect(await terms.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
    // No app message: the browser's own bubble explains it.
    await expect(page.getByRole('alert')).toHaveCount(0);

    const context = await browser.newContext({ storageState: member, javaScriptEnabled: false });
    const blocks = await context.newPage();
    const blocked = posts(blocks);
    await blocks.goto('/settings/blocks');
    const handle = blocks.locator('input[name="handle"]');
    await handle.locator('xpath=ancestor::form[1]').locator('button[type="submit"]').click();
    await expect(handle).toBeFocused();
    expect(await handle.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await expect(blocks.getByRole('alert')).toHaveCount(0);
    expect(sent() + blocked()).toBe(0);
    await context.close();
  });
});
