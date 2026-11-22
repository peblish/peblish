import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { readSetting } from '../../packages/core/src/settings/read.ts';
import { seedSetting } from '../../packages/core/src/testing/seed-a.ts';
import { defaultBanner, type SiteBanner } from '../../packages/schema/src/banner.ts';
import type { SiteBrand, SiteWidth } from '../../packages/schema/src/site-settings.ts';
import type { Admin } from '../auth/support.ts';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { colours } from '../support/contrast.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { seedAdm, signInAdmin } from './support.ts';

// The site banner and the layout width (Commons): the admin form publishes them through the audited settings
// writer, the shell shows the banner on every page and applies the width to the frame. It saves settings every
// page reads, so it is a serial spec, and it puts them back after.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

let admin: Admin;
let member: { name: string; password: string };
let page: Page;
let saved: { banner: SiteBanner; width: SiteWidth; brand: SiteBrand } | undefined;

test.beforeAll(async ({ browser }) => {
  saved = { banner: await readSetting('site.banner'), width: await readSetting('site.width'), brand: await readSetting('site.brand') };
  await seedSetting('site.banner', defaultBanner);
  await seedSetting('site.width', 'default');
  ({ admin, member } = seedAdm('e2e') as { admin: Admin; member: { name: string; password: string } });
  page = await (await browser.newContext()).newPage();
  await signInAdmin(page, admin);
});
test.afterAll(async () => {
  await page.context().close();
  if (saved) {
    await seedSetting('site.banner', saved.banner);
    await seedSetting('site.width', saved.width);
    await seedSetting('site.brand', saved.brand);
  }
  await closePools();
});

const form = (page: Page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Publish banner' }) });
const shellBanner = (page: Page) => page.locator('.pb-app__banner');
/** The settings changes the modlog holds, oldest first (packages/core/src/testing/seed-adm.ts). */
const settingsLog = () => seedAdm('settings-log') as { changes: Record<string, { before: unknown; after: unknown }>; public: boolean }[];
/** Picks a Mux radio by its label, which draws it over the hidden native input. */
const choose = (scope: Locator, name: string) =>
  scope.getByRole('radio', { name, exact: true }).locator('xpath=ancestor::label[1]').click();

async function fillBanner(
  page: Page,
  fields: Partial<Record<'Title' | 'Message' | 'Button label' | 'Button address' | 'Link label' | 'Link address', string>>,
) {
  for (const [label, value] of Object.entries(fields)) await form(page).getByLabel(label, { exact: true }).fill(value);
}

test('a malformed stored banner or width leaves every page up, the admin page says so, and a save replaces it', async () => {
  await seedSetting('site.banner', { ...defaultBanner, enabled: true, message: 'Typo.', icon: 'typo' });
  await seedSetting('site.width', 'full');
  for (const path of ['/', '/communities', '/admin/settings']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(shellBanner(page), path).toHaveCount(0);
    await expect(page.locator('.pb-app'), path).toHaveAttribute('data-width', 'default');
  }
  await gotoHydrated(page, '/admin/settings');
  await expect(page.locator('#banner').getByRole('alert')).toHaveText(/The saved banner could not be read/);
  await expect(page.locator('#layout').getByRole('alert')).toHaveText(/The saved width could not be read/);
  await page.getByRole('button', { name: 'Save width' }).click();
  await page.waitForURL(/saved=width/);
  await form(page).getByRole('button', { name: 'Publish banner' }).click();
  await page.waitForURL(/saved=banner/);
  await expect(page.getByRole('alert').filter({ hasText: 'could not be read' })).toHaveCount(0);
  expect(await readSetting('site.width')).toBe('default');
  expect(await readSetting('site.banner')).toEqual({ ...defaultBanner, colour: '#007BA7', revision: 1 });
  // Put back to no banner at all, as the cases below expect.
  await seedSetting('site.banner', defaultBanner);
});

test('an admin publishes a banner: the shell shows it on every page, server-rendered, and the modlog has the change', async () => {
  const console = recordConsole(page);
  await gotoHydrated(page, '/admin/settings');
  await expect(page.getByRole('heading', { name: 'Site banner' })).toBeVisible();
  await expect(shellBanner(page)).toHaveCount(0);
  const before = settingsLog().length;
  await form(page).getByText('Show the banner', { exact: true }).click();
  await fillBanner(page, {
    Title: 'Read-only window',
    Message: 'Posting pauses for an hour on Sunday. Reading works.',
    'Button label': 'Details',
    'Button address': '/about',
    'Link label': 'Rules',
    'Link address': '/rules',
  });
  await form(page).getByLabel('Icon').selectOption('wrench');
  await choose(form(page), 'Accent');
  // The previews follow the draft before anything is published.
  await expect(page.getByRole('region', { name: 'Preview, light theme' })).toContainText('Posting pauses for an hour');
  await expect(page.getByRole('region', { name: 'Preview, dark theme' }).getByRole('button', { name: 'Details' })).toBeVisible();
  await form(page).getByRole('button', { name: 'Publish banner' }).click();
  await page.waitForURL(/saved=banner#banner$/);
  await expect(page.getByRole('status').filter({ hasText: 'Banner published.' })).toBeVisible();
  const published = await readSetting('site.banner');
  expect(published).toMatchObject({
    enabled: true,
    revision: 1,
    title: 'Read-only window',
    tone: 'accent',
    icon: 'wrench',
    primary: { label: 'Details', href: '/about' },
    link: { label: 'Rules', href: '/rules' },
  });
  const log = settingsLog();
  expect(log).toHaveLength(before + 1);
  expect(log.at(-1)).toEqual({ public: false, changes: { 'site.banner': { before: defaultBanner, after: published } } });
  // Every page, in the server's HTML.
  for (const path of ['/', '/communities', '/about']) {
    const html = await (await page.request.get(path)).text();
    expect(html, path).toContain('aria-label="Site notice"');
    expect(html, path).toContain('Posting pauses for an hour on Sunday.');
  }
  await gotoHydrated(page, '/');
  const region = page.getByRole('region', { name: 'Site notice' });
  await expect(region).toContainText('Read-only window');
  // Under the header, across the window.
  const [top, box] = [await page.locator('.pb-top').boundingBox(), await region.boundingBox()];
  expect(box!.y).toBeCloseTo(top!.y + top!.height, 0);
  expect(box!.width).toBe(1440);
  await region.getByRole('button', { name: 'Details' }).click();
  await landed(page, '/about');
  await region.getByRole('link', { name: 'Rules' }).click();
  await landed(page, '/rules');
  await expectAccessible(page);
  expect(console.hydrationProblems()).toEqual([]);
});

test('the form refuses what the banner may not hold, marks the field and focuses it, and posts nothing', async () => {
  await gotoHydrated(page, '/admin/settings');
  const url = page.url();
  const cases: [Parameters<typeof fillBanner>[1], string, string][] = [
    [{ Message: '' }, 'Message', 'A banner that is shown needs a message'],
    [{ 'Link address': 'https://example.test/rules' }, 'Link address', 'A page on this site, starting with /'],
    [{ 'Button address': '//example.test' }, 'Button address', 'A page on this site, starting with /'],
    [{ 'Link label': '' }, 'Link label', 'Give the action a label'],
  ];
  for (const [fields, label, error] of cases) {
    await gotoHydrated(page, '/admin/settings');
    await fillBanner(page, fields);
    await form(page).getByRole('button', { name: 'Publish banner' }).click();
    const field = form(page).getByLabel(label, { exact: true });
    await expect(field, label).toBeFocused();
    await expect(field, label).toHaveAttribute('aria-invalid', 'true');
    await expect(field, label).toHaveAccessibleDescription(new RegExp(error));
    expect(page.url()).toBe(url);
  }
  expect((await readSetting('site.banner')).revision).toBe(1);
  // The server keeps the same rules when the form posts without its check, here with scripts off.
  const context = await page
    .context()
    .browser()!
    .newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const plain = await context.newPage();
  await plain.goto('/admin/settings');
  await fillBanner(plain, { 'Link address': 'https://example.test/rules' });
  await form(plain).getByRole('button', { name: 'Publish banner' }).click();
  await plain.waitForURL(/\?error=settings\.invalid&field=banner\.link\.href#banner$/);
  await expect(form(plain).getByLabel('Link address', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(plain.locator('#banner').getByRole('alert').filter({ hasText: 'Nothing was saved.' })).toBeVisible();
  await context.close();
  expect((await readSetting('site.banner')).revision).toBe(1);
});

test('Custom: the colour field shows for Custom only, Enter applies a colour without publishing, and hard colours still read at 4.5:1', async () => {
  await gotoHydrated(page, '/admin/settings');
  const colour = form(page).getByRole('textbox', { name: 'Colour' });
  await expect(colour).toBeHidden();
  await choose(form(page), 'Custom');
  await expect(colour).toBeVisible();
  const url = page.url();
  for (const hex of ['#D6409F', '#808080', '#FF0000', '#FFC53D', '#1E3A8A']) {
    await colour.fill(hex);
    await colour.press('Enter');
    expect(page.url()).toBe(url);
    for (const emphasis of ['Subtle', 'Solid']) {
      await choose(form(page), emphasis);
      // Measured once nothing is between two colours.
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      for (const scheme of ['light', 'dark']) {
        const preview = page.getByRole('region', { name: `Preview, ${scheme} theme` });
        await expect(preview).toHaveAttribute('data-muxui-tone', 'custom');
        for (const part of [
          preview.locator('.muxui-banner__message'),
          preview.locator('.muxui-banner__title'),
          preview.locator('.muxui-banner__link'),
        ]) {
          const text = (await colours(part)).text!;
          expect(text.ratio, `${hex} ${emphasis} ${scheme}`).toBeGreaterThanOrEqual(4.5);
        }
        const label = (await colours(preview.locator('.muxui-banner__action .muxui-button__label'))).text!;
        expect(label.ratio, `${hex} ${emphasis} ${scheme} button`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  await form(page).getByRole('button', { name: 'Publish banner' }).click();
  await page.waitForURL(/saved=banner/);
  expect(await readSetting('site.banner')).toMatchObject({ tone: 'custom', colour: '#1E3A8A', emphasis: 'solid', revision: 2 });
});

test('an empty colour for Custom is refused at the colour field; a double press of Publish publishes once', async ({ browser }) => {
  await gotoHydrated(page, '/admin/settings');
  const url = page.url();
  await choose(form(page), 'Custom');
  const colour = form(page).getByRole('textbox', { name: 'Colour' });
  await colour.fill('');
  await colour.press('Tab');
  await form(page).getByRole('button', { name: 'Publish banner' }).click();
  await expect(colour).toBeFocused();
  await expect(colour).toHaveAttribute('aria-invalid', 'true');
  await expect(colour).toHaveAccessibleDescription(/Custom needs a colour as #RRGGBB/);
  expect(page.url()).toBe(url);
  // Typed with scripts off, the colour is posted as typed and read by the server.
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const plain = await context.newPage();
  await plain.goto('/admin/settings');
  await choose(form(plain), 'Custom');
  await form(plain).getByRole('textbox', { name: 'Colour' }).fill('#0e9f6e');
  await form(plain).getByRole('button', { name: 'Publish banner' }).click();
  await plain.waitForURL(/saved=banner/);
  await context.close();
  const before = await readSetting('site.banner');
  expect(before).toMatchObject({ tone: 'custom', colour: '#0e9f6e' });
  await gotoHydrated(page, '/admin/settings');
  await form(page).getByRole('button', { name: 'Publish banner' }).dblclick();
  await page.waitForURL(/saved=banner/);
  await expect(page.getByRole('status').filter({ hasText: 'Banner published.' })).toBeVisible();
  expect((await readSetting('site.banner')).revision).toBe(before.revision + 1);
});

test('dismissing hides the banner in this browser and focuses the page; a reload keeps it hidden; a new revision shows it again', async () => {
  await gotoHydrated(page, '/');
  await page.getByRole('region', { name: 'Site notice' }).getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(shellBanner(page)).toHaveCount(0);
  await expect(page.locator('#pb-main main')).toBeFocused();
  const cookie = (await page.context().cookies()).find(({ name }) => name === 'peblish_banner');
  const { revision } = await readSetting('site.banner');
  expect(cookie?.value).toBe(String(revision));
  // The server leaves a dismissed banner out, so nothing moves when the page hydrates.
  expect(await (await page.request.get('/')).text()).not.toContain('aria-label="Site notice"');
  await gotoHydrated(page, '/communities');
  await expect(shellBanner(page)).toHaveCount(0);
  // Show banner again, in this browser only.
  await gotoHydrated(page, '/admin/settings');
  const again = form(page).getByRole('button', { name: 'Show banner again' });
  await expect(again).toBeEnabled();
  await again.click();
  await expect(shellBanner(page)).toBeVisible();
  await expect(again).toBeDisabled();
  await page.getByRole('region', { name: 'Site notice' }).getByRole('button', { name: 'Dismiss notice' }).click();
  // Publishing again, unchanged, raises the revision, so the banner shows again where it was dismissed.
  await form(page).getByRole('button', { name: 'Publish banner' }).click();
  await page.waitForURL(/saved=banner/);
  expect((await readSetting('site.banner')).revision).toBe(revision + 1);
  await expect(page.getByRole('region', { name: 'Site notice' })).toBeVisible();
});

test('with scripts off the banner shows with its message and link, its script-only controls are left out, and the forms post', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const plain = await context.newPage();
  await plain.goto('/');
  const region = plain.getByRole('region', { name: 'Site notice' });
  await expect(region).toContainText('Posting pauses for an hour');
  await expect(region.getByRole('link', { name: 'Rules' })).toBeVisible();
  await expect(region.getByRole('button', { name: 'Dismiss notice' })).toBeHidden();
  await expect(region.getByRole('button', { name: 'Details' })).toBeHidden();
  await plain.goto('/admin/settings');
  await choose(plain.locator('body'), 'Wide, 1112 px');
  await plain.getByRole('button', { name: 'Save width' }).click();
  await plain.waitForURL(/saved=width#layout$/);
  expect(await readSetting('site.width')).toBe('wide');
  await expect(plain.locator('.pb-app')).toHaveAttribute('data-width', 'wide');
  await context.close();
});

/** The frame's width on `path` at a window width, signed in as the admin, the sidebar folded to its rail. */
async function frame(browser: Browser, path: string, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, storageState: await page.context().storageState() });
  await context.addCookies([{ name: 'peblish_side', value: 'rail', url: new URL(page.url()).origin }]);
  const view = await context.newPage();
  await gotoHydrated(view, path);
  const measured = Math.round((await view.locator('#pb-main').boundingBox())!.width);
  await context.close();
  return measured;
}

test("each width saved through the form is the frame's preset, and a staff table keeps its wide centre at every preset", async ({
  browser,
}) => {
  // The widths themselves are measured in e2e/shell/banner-width.serial.spec.ts.
  const staff = new Set<number>();
  for (const width of ['narrow', 'default', 'wide'] as const) {
    await gotoHydrated(page, '/admin/settings');
    await choose(page.locator('form').filter({ has: page.getByRole('button', { name: 'Save width' }) }), labelOf(width));
    await page.getByRole('button', { name: 'Save width' }).click();
    await page.waitForURL(/saved=width#layout$/);
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    expect(await readSetting('site.width')).toBe(width);
    await expect(page.locator('.pb-app')).toHaveAttribute('data-width', width);
    // Audited as the banner is, unless the preset was already the one saved.
    const last = settingsLog().at(-1)!;
    if (width !== 'default')
      expect(last).toEqual({ public: false, changes: { 'site.width': { before: expect.anything(), after: width } } });
    staff.add(await frame(browser, '/admin/reports', 1440));
  }
  expect(staff.size).toBe(1);
});

const labelOf = (width: SiteWidth) => ({ narrow: 'Narrow, 872 px', default: 'Default, 952 px', wide: 'Wide, 1112 px' })[width];

test('a member who is no admin sees no banner form and cannot write the banner or the width', async ({ browser }) => {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.goto('/auth/sign-in');
  await signIn(visitor, `@${member.name}`, member.password);
  await landed(visitor, '/');
  await visitor.goto('/admin/settings');
  await expect(visitor.getByRole('alert')).toHaveText('Only site admins can use this page.');
  await expect(visitor.getByRole('heading', { name: 'Site banner' })).toHaveCount(0);
  const before = { banner: await readSetting('site.banner'), width: await readSetting('site.width') };
  for (const body of [
    { intent: 'banner', 'banner.enabled': 'on', 'banner.message': 'Not from an admin', 'banner.tone': 'danger' },
    { intent: 'width', 'site.width': 'narrow' },
  ]) {
    // Posted from the page, with its cookies, as the form would.
    const landedAt = await visitor.evaluate(
      async (fields) => (await fetch('/admin/settings', { method: 'POST', body: new URLSearchParams(fields) })).url,
      body,
    );
    expect(landedAt).toMatch(/\/admin\/settings\?error=auth\.admin_required$/);
  }
  expect({ banner: await readSetting('site.banner'), width: await readSetting('site.width') }).toEqual(before);
  await context.close();
});
