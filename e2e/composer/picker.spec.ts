import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { contrast } from '../support/contrast.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { choose, community, communityField, communityRadio, openCommunities, radioLabel, seed, type Seed, signedIn } from './support.ts';

// Create post's community field (CommunityField on Mux ComboBox): the person's joined communities first, the rest,
// then Browse; keyboard-complete; the chosen community posted under the same name and value as the radio list a
// browser without scripts still gets. Seeds the lane database, so against a remote BASE_URL it skips.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.setTimeout(90_000);

let world: Seed;
let poster: BrowserContext;
test.beforeAll(async ({ browser, baseURL }) => {
  world = seed();
  poster = await signedIn(browser, baseURL!, world.people.poster, world.password);
});
test.afterAll(() => poster.close());

const group = (page: Page, name: string) => page.getByRole('listbox').getByRole('group', { name });
const posted = (page: Page) => page.locator('form input[name="community"]');
const rules = (page: Page) => page.getByRole('complementary', { name: 'Community rules' });

/**
 * Waits until the field's list has finished opening and nothing in it moves, so colours are read at rest: Mux UI fades
 * the list in by script, through an opacity on its popover that it removes once the list is in place, and a row's
 * highlight eases in by transition. A fast server measures before either ends.
 */
const listSettled = (page: Page) =>
  expect
    .poll(() =>
      page
        .locator('.muxui-combo-box__popover')
        .evaluate(
          (popover: HTMLElement) =>
            popover.style.opacity === '' && popover.getAnimations({ subtree: true }).every(({ playState }) => playState !== 'running'),
        ),
    )
    .toBe(true);

test('the field lists joined communities first, then the rest, then Browse, each a named group', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await openCommunities(page);
  const { open, remote, remoteStaff, gone } = world.communities;
  await expect(group(page, 'Joined').getByRole('option', { name: new RegExp(`^!${remote.handle}`) })).toBeVisible();
  await expect(group(page, 'Not joined').getByRole('option', { name: new RegExp(`^!${open.handle}$`) })).toBeVisible();
  await expect(group(page, 'Directory').getByRole('option', { name: 'Browse all communities' })).toBeVisible();
  // A closed one is shown with its reason and cannot be chosen; a removed one is not there at all.
  await expect(community(page, remoteStaff.handle)).toBeDisabled();
  await expect(community(page, remoteStaff.handle)).toContainText('posting disabled for you');
  await expect(community(page, gone.handle)).toHaveCount(0);
  // The open list hides the rest of the page from assistive technology (React Aria), so the page is checked closed,
  // once the list has faded out and left.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expectAccessible(page);
  await page.close();
});

test('a joined community with a display name is shown by it, its handle after, and found and chosen by it', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  const { named } = world.communities;
  await openCommunities(page);
  const row = group(page, 'Joined').getByRole('option', { name: 'Kettle Watchers', exact: true });
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleDescription(new RegExp(`^!${named.handle}, remote`));
  await communityField(page).fill('kettle watch');
  await row.click();
  await expect(communityField(page)).toHaveValue(`Kettle Watchers (!${named.handle})`);
  await expect(posted(page)).toHaveValue(named.id);
  await page.close();
});

test('Enter takes the first community shown, Escape keeps it, Tab chooses nothing, and emptying the field clears it', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  const { open, remote } = world.communities;
  const field = communityField(page);
  await field.click();
  await page.keyboard.type(open.handle);
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue(`!${open.handle}`);
  await expect(posted(page)).toHaveValue(open.id);
  await expect(rules(page).getByRole('heading', { level: 2 })).toContainText(open.handle);
  // Typing something else and leaving with Tab keeps the choice and puts its name back.
  await field.fill(remote.handle.slice(0, 6));
  await page.keyboard.press('Escape');
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Tab');
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue(`!${open.handle}`);
  await expect(posted(page)).toHaveValue(open.id);
  // Emptied, it chooses nothing, and the rules go.
  await field.fill('');
  await expect(posted(page)).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(rules(page)).toContainText('Choose a community');
  // The arrows run from one group into the next, past the rows that cannot be chosen.
  await page.keyboard.type(world.communities.open.handle.replace(/^open_/, ''));
  const groupOf = () =>
    field.evaluate((input) => {
      const row = document.getElementById(input.getAttribute('aria-activedescendant') ?? '');
      const heading = row?.closest('[role="group"]')?.getAttribute('aria-labelledby');
      return heading ? (document.getElementById(heading)?.textContent ?? '') : '';
    });
  const enabled = (name: string) => group(page, name).locator('[role="option"]:not([aria-disabled="true"])');
  const steps = await enabled('Joined').count();
  expect(steps).toBeGreaterThan(0);
  const seen: string[] = [];
  for (let step = 0; step <= steps + 1; step++) {
    await page.keyboard.press('ArrowDown');
    seen.push(await groupOf());
  }
  // Joined rows, then straight on into the next group.
  const next = seen.indexOf('Not joined');
  expect(next, seen.join(', ')).toBeGreaterThan(0);
  expect(
    seen.slice(0, next).every((name) => name === 'Joined'),
    seen.join(', '),
  ).toBe(true);
  await page.close();
});

/** The poster's session in a browser that has stored nothing yet: no draft another test left behind. */
async function freshPoster(browser: Browser, baseURL: string) {
  const { cookies } = await poster.storageState();
  return browser.newContext({ baseURL, storageState: { cookies, origins: [] } });
}
const draftKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((name) => name.startsWith('peblish.draft:')));
/** The drafts this browser keeps, as {slot: title}: a community's id, `none` or `carried`. */
const stored = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((name) => name.startsWith('peblish.draft:'))
        .map((name) => [name.split(':').at(-1), (JSON.parse(localStorage.getItem(name)!) as { title: string }).title]),
    ),
  );
const body = (page: Page) => page.getByRole('textbox', { name: 'Body', exact: true });

/**
 * The page back at the top before the field is typed in: a scroll closes the field's list (React Aria), and the
 * scroll's event comes with the next frame, which a busy page can draw after the list has opened. So it waits for that
 * frame (its scroll event comes before its animation-frame callbacks).
 */
const toTop = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        window.scrollTo({ top: 0, behavior: 'instant' });
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );

/** To the directory from the field. */
async function browseAway(page: Page) {
  await toTop(page);
  await communityField(page).fill('zzzz no such community');
  await page.getByRole('option', { name: 'Browse all communities' }).click();
}

test('with nothing matching it says so over Browse, which keeps the text for Create post wherever it opens next', async ({
  browser,
  baseURL,
}) => {
  const context = await freshPoster(browser, baseURL!);
  const page = await context.newPage();
  const { open, remote } = world.communities;
  await gotoHydrated(page, '/submit');
  // A community already chosen: the text is not kept under it, since another may be found.
  await choose(page, remote.handle);
  await page.getByLabel('Title').fill('Kept while browsing');
  await body(page).fill('Words to keep');
  await toTop(page);
  await communityField(page).fill('zzzz no such community');
  const browse = page.getByRole('option', { name: 'Browse all communities' });
  await expect(browse).toHaveAccessibleDescription('No community matches.');
  await browse.click();
  await page.waitForURL('**/communities');

  // Back with none chosen: the text, and no community until one is chosen.
  await gotoHydrated(page, '/submit');
  await expect(page.getByLabel('Title')).toHaveValue('Kept while browsing');
  await expect(communityField(page)).toHaveValue('');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('Choose a community to post in.').first()).toBeVisible();
  expect(page.url()).toMatch(/\/submit$/);

  // Opened for the community found there: the text again, and posting it leaves no copy behind.
  await gotoHydrated(page, `/submit?community=${open.handle}`);
  await expect(page.getByLabel('Title')).toHaveValue('Kept while browsing');
  await expect(body(page)).toHaveValue('Words to keep');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  expect(await draftKeys(page)).toEqual([]);
  await context.close();
});

test('a saved draft that Browse takes along leaves no copy under its community once posted elsewhere', async ({ browser, baseURL }) => {
  const context = await freshPoster(browser, baseURL!);
  const page = await context.newPage();
  const { open, remote } = world.communities;
  await gotoHydrated(page, '/submit');
  await choose(page, open.handle);
  await page.getByLabel('Title').fill('Saved, then carried');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await gotoHydrated(page, '/submit');
  await choose(page, open.handle);
  await expect(page.getByLabel('Title')).toHaveValue('Saved, then carried');
  await browseAway(page);
  await page.waitForURL('**/communities');
  await gotoHydrated(page, `/submit?community=${remote.handle}`);
  await expect(page.getByLabel('Title')).toHaveValue('Saved, then carried');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  expect(await draftKeys(page)).toEqual([]);
  await context.close();
});

test('a text carried in beside a community’s own saved draft is kept apart: discarding or posting it leaves that draft', async ({
  browser,
  baseURL,
}) => {
  const context = await freshPoster(browser, baseURL!);
  const page = await context.newPage();
  const { open } = world.communities;
  const saveForB = async () => {
    await gotoHydrated(page, '/submit');
    await choose(page, open.handle);
    await page.getByLabel('Title').fill('Saved for B');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved in this browser.')).toBeVisible();
  };
  const carryIn = async (title: string) => {
    await gotoHydrated(page, '/submit');
    await page.getByLabel('Title').fill(title);
    await browseAway(page);
    await page.waitForURL('**/communities');
    await gotoHydrated(page, `/submit?community=${open.handle}`);
    await expect(page.getByLabel('Title')).toHaveValue(title);
    await expect(page.getByText('Your saved draft for this community is kept')).toBeVisible();
  };
  await saveForB();
  await carryIn('Carried, then discarded');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => stored(page)).toEqual({ [open.id]: 'Saved for B' });

  await carryIn('Carried, then posted');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  expect(await stored(page)).toEqual({ [open.id]: 'Saved for B' });

  // B's own comes back after a reload, and posting it clears it.
  await gotoHydrated(page, `/submit?community=${open.handle}`);
  await expect(page.getByLabel('Title')).toHaveValue('Saved for B');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  expect(await stored(page)).toEqual({});
  await context.close();
});

test('closing the sheet keeps what was written without writing over a community’s other saved draft', async ({ browser, baseURL }) => {
  const context = await freshPoster(browser, baseURL!);
  const page = await context.newPage();
  const { open } = world.communities;
  await gotoHydrated(page, '/submit');
  await choose(page, open.handle);
  await page.getByLabel('Title').fill('Saved for B');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved in this browser.')).toBeVisible();

  await gotoHydrated(page, '/');
  const create = page.getByRole('link', { name: 'Create post' });
  const sheet = page.getByRole('dialog', { name: 'Create post' });
  await create.click();
  await sheet.getByLabel('Title').fill('Written in the sheet');
  // Typed first, so B's saved draft is not laid over it.
  await choose(sheet, open.handle);
  await expect(sheet.getByLabel('Title')).toHaveValue('Written in the sheet');
  await sheet.getByLabel('Title').press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(await stored(page)).toEqual({ [open.id]: 'Saved for B', carried: 'Written in the sheet' });
  // The sheet's text comes back the next time.
  await create.click();
  await expect(sheet.getByLabel('Title')).toHaveValue('Written in the sheet');
  await context.close();
});

test('Browse asks before leaving text it cannot keep, never replaces another kept draft, and a discard leaves none', async ({
  browser,
  baseURL,
}) => {
  const context = await freshPoster(browser, baseURL!);
  // This browser refuses the draft Browse carries, as a full or blocked storage would, until told otherwise.
  await context.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name.endsWith(':carried') && (window as { keepCarried?: boolean }).keepCarried !== true)
        throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  });
  const page = await context.newPage();
  await gotoHydrated(page, '/submit');
  await page.getByLabel('Title').fill('Not kept');
  let asked = '';
  page.once('dialog', (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await browseAway(page);
  await expect.poll(() => asked).toContain('cannot keep');
  // Declined: still writing, the text where it was.
  expect(page.url()).toMatch(/\/submit$/);
  await expect(page.getByLabel('Title')).toHaveValue('Not kept');

  // Another tab's carried draft is waiting: it stays as it is, and leaving without this text is asked first.
  await page.evaluate(() => Object.assign(window, { keepCarried: true }));
  const carried = `peblish.draft:${await page.evaluate(() => localStorage.getItem('pb-viewer'))}:carried`;
  const other = JSON.stringify({ type: 'text', title: 'Carried by another tab', url: '', body: '', nsfw: false });
  await page.evaluate(([name, value]) => localStorage.setItem(name!, value!), [carried, other]);
  page.once('dialog', (dialog) => {
    asked = dialog.message();
    void dialog.accept();
  });
  await browseAway(page);
  await page.waitForURL('**/communities');
  expect(asked).toContain('already');
  expect(await page.evaluate((name) => localStorage.getItem(name), carried)).toBe(other);

  // Create post finds that one; discarding it leaves no draft.
  await gotoHydrated(page, `/submit?community=${world.communities.open.handle}`);
  await expect(page.getByLabel('Title')).toHaveValue('Carried by another tab');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => draftKeys(page)).toEqual([]);
  await context.close();
});

test('the open list passes axe, and on a phone each row is a 44px target', async () => {
  const page = await poster.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoHydrated(page, '/submit');
  await openCommunities(page);
  const list = page.getByRole('listbox');
  // The list fades in: axe reads colours once it has.
  await listSettled(page);
  const results = await new AxeBuilder({ page })
    .include('[role="listbox"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    // Each row is named by its label part and described by the rest (React Aria's label and description slots), so
    // its name is the handle and not all of its text: the description is read after the name, not lost.
    .disableRules(['label-content-name-mismatch'])
    .analyze();
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target.join(' ')) }))).toEqual([]);
  const rows = await list.getByRole('option').all();
  expect(rows.length).toBeGreaterThan(2);
  for (const row of rows) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.close();
});

test('in the sheet, Escape closes the list and leaves the sheet open', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/');
  await page.getByRole('banner').getByRole('link', { name: 'Create post' }).click();
  const sheet = page.getByRole('dialog', { name: 'Create post' });
  await choose(sheet, world.communities.open.handle);
  await openCommunities(sheet);
  await page.keyboard.press('Escape');
  await expect(communityField(sheet)).toHaveAttribute('aria-expanded', 'false');
  await expect(sheet).toBeVisible();
  await expect(communityField(sheet)).toHaveValue(`!${world.communities.open.handle}`);
  await page.close();
});

test('without scripts the radio list is the field, and the radio chosen is what posts', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, storageState: await poster.storageState() });
  const page = await context.newPage();
  const { open, closed } = world.communities;
  await page.goto(`/submit?community=${open.handle}`);
  await expect(communityField(page)).toBeHidden();
  await expect(communityRadio(page, open.handle)).toBeChecked();
  // Another radio than the one asked for in the address is what posts.
  await choose(page, closed.handle);
  await page.getByLabel('Title').fill('Posted without scripts');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\//);
  await expect(page.getByRole('main')).toContainText(closed.handle);
  await context.close();
});

test('with its scripts slow, a radio chosen before the page hydrates is the choice the field takes over', async ({ browser, baseURL }) => {
  const context = await freshPoster(browser, baseURL!);
  const page = await context.newPage();
  const { open, remote } = world.communities;
  // Every script asked for in the first seconds waits until then: the person has the server's page to act on.
  let release = 0;
  await page.route('**/*', async (route) => {
    const wait = release - Date.now();
    if (route.request().resourceType() === 'script' && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await route.continue();
  });
  release = Date.now() + 4_000;
  await page.goto(`/submit?community=${open.handle}`, { waitUntil: 'commit' });
  const radio = communityRadio(page, remote.handle);
  await expect(communityRadio(page, open.handle)).toBeChecked();
  await radioLabel(radio).click();
  await expect(radio).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.dataset.hydrated)).toBeUndefined();
  // Back to the top before the page hydrates: the view header's observer (shell/view-header.tsx, another lane's)
  // fails on a bar scrolled above the window then (a negative rootMargin), which shows the error page.
  await page.evaluate(() => window.scrollTo(0, 0));
  // Hydrated: the field shows that choice, posts it and shows its rules; the radios are gone.
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached', timeout: 30_000 });
  await expect(communityField(page)).toHaveValue(`!${remote.handle}`);
  await expect(posted(page)).toHaveValue(remote.id);
  await expect(rules(page).getByRole('heading', { level: 2 })).toContainText(remote.handle);
  await expect(page.getByRole('radio', { name: new RegExp(`^!${remote.handle}`) })).toHaveCount(0);
  await context.close();
});

test('the open list reads at 4.5:1 or more in light and dark, at rest and highlighted', async ({ browser, baseURL }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ baseURL, colorScheme, storageState: await poster.storageState() });
    const page = await context.newPage();
    await gotoHydrated(page, '/submit');
    const field = communityField(page);
    await field.click();
    await page.keyboard.type(world.communities.open.handle.replace(/^open_/, ''));
    await listSettled(page);
    const list = page.getByRole('listbox');
    const texts = list.locator('.pb-cfield__title, .pb-cfield__meta');
    // At rest, every enabled row's name and description; the disabled rows are exempt (WCAG 1.4.3).
    for (const text of await list
      .locator('[role="option"]:not([aria-disabled="true"])')
      .locator('.pb-cfield__title, .pb-cfield__meta')
      .all()) {
      expect(await contrast(text), colorScheme).toBeGreaterThanOrEqual(4.5);
    }
    expect(await texts.count()).toBeGreaterThan(0);
    // Highlighted: the first row the arrows reach.
    await page.keyboard.press('ArrowDown');
    const active = page.locator('[role="option"][data-muxui-state-focused], [role="option"][data-focused]').first();
    await expect(active).toBeVisible();
    await listSettled(page);
    for (const text of await active.locator('.pb-cfield__title, .pb-cfield__meta').all()) {
      expect(await contrast(text), `${colorScheme}, highlighted`).toBeGreaterThanOrEqual(4.5);
    }
    // The row to the directory, in the link colour, with nothing matching.
    await field.fill('zzzz no such community');
    await expect(page.getByRole('option', { name: 'Browse all communities' })).toBeVisible();
    await listSettled(page);
    expect(
      await contrast(page.getByRole('option', { name: 'Browse all communities' }).locator('.pb-cfield__browse')),
      colorScheme,
    ).toBeGreaterThanOrEqual(4.5);
    await context.close();
  }
});
