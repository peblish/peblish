import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { recordConsole } from '../support/route-marker.ts';

// LinkedDisclosure and ButtonLink (packages/ui/src/components) in a browser. No route renders
// them yet, and this lane may not edit one, so they run on a harness page (harness/app.jsx):
// built here with packages/web's Vite from the app's own two stylesheets, rendered on the
// "server" by its bundled server.mjs and hydrated by its client bundle. Playwright serves it at
// a made-up origin through context.route, so the spec needs neither the app server nor a
// database. Screenshots go to UI_PIECES_SHOTS when it is set, else to e2e/artifacts/ui-pieces.

const origin = 'http://ui-pieces.test';
const out = join(import.meta.dirname, '../artifacts/ui-pieces-harness');
const shots = process.env.UI_PIECES_SHOTS ?? join(import.meta.dirname, '../artifacts/ui-pieces');
mkdirSync(shots, { recursive: true });

type Assets = { script: string; css: string[] };
type Render = (url: string, assets: Assets) => string;
type Chunk = { file: string; css?: string[]; isEntry?: boolean };

let render: Render;
let assets: Assets;

test.beforeAll(async () => {
  execFileSync('node', [join(import.meta.dirname, 'harness/build.mjs'), out], { stdio: 'pipe' });
  const manifest: Record<string, Chunk> = JSON.parse(readFileSync(join(out, 'client/.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  if (!entry) throw new Error('the harness build has no entry chunk');
  assets = { script: `/${entry.file}`, css: (entry.css ?? []).map((file) => `/${file}`) };
  const server: { render: Render } = await import(pathToFileURL(join(out, 'server/server.mjs')).href);
  render = server.render;
});

type Open = { path?: string; js?: boolean; width?: number; scheme?: 'light' | 'dark'; holdScript?: boolean };

/**
 * A page on the harness. The document is rendered per request; a POST answers with what was
 * posted, any other path with its own name. `holdScript` keeps the client bundle back until
 * `release()`, so the server's markup can be measured before hydration.
 */
async function open(browser: Browser, { path = '/', js = true, width = 1024, scheme = 'light', holdScript = false }: Open = {}) {
  const context = await browser.newContext({
    javaScriptEnabled: js,
    viewport: { width, height: 900 },
    colorScheme: scheme,
    reducedMotion: 'reduce',
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/assets/')) {
      if (holdScript && url.pathname.endsWith('.js')) await held;
      return route.fulfill({ path: join(out, 'client', url.pathname) });
    }
    if (request.method() === 'POST') return route.fulfill({ contentType: 'text/html', body: `<p>Posted ${request.postData()}</p>` });
    if (url.pathname !== '/') return route.fulfill({ contentType: 'text/html', body: `<p>Page ${url.pathname}</p>` });
    return route.fulfill({ contentType: 'text/html', body: render(url.href, assets) });
  });
  const page = await context.newPage();
  const logs = recordConsole(page);
  // A held module script also holds back DOMContentLoaded, so wait for the markup instead.
  await page.goto(origin + path, { waitUntil: holdScript ? 'commit' : 'load' });
  await page.locator('#root').waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  if (js && !holdScript) await hydrated(page);
  return { context, page, logs, release };
}

const hydrated = (page: Page) => page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error('no box: the element is not rendered');
  return found;
};

/**
 * Every box in the disclosure columns, to compare before and after hydration. A closed panel's
 * content is left out: React Aria swaps the server's `hidden` for a zero-height, inert panel,
 * so those boxes move without anything on screen moving; the columns' own boxes still count.
 */
const layout = (page: Page) =>
  page.locator('[data-testid=linked], [data-testid=reference], [data-testid=long]').evaluateAll((columns) =>
    columns.flatMap((column) =>
      [column, ...column.querySelectorAll('*:not(.muxui-disclosure__panel-host, .muxui-disclosure__panel-host *)')].map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(Math.round).join(',');
      }),
    ),
  );

test('scripts on: a grouped Mux Disclosure, the same before and after hydration, that toggles', async ({ browser }) => {
  const { context, page, logs, release } = await open(browser, { holdScript: true });
  const linked = page.getByTestId('linked');
  const reference = page.getByTestId('reference');
  // Before hydration: the Disclosure shows, the stand-in link does not, and it is drawn as Mux draws one.
  await expect(linked.getByRole('button', { name: 'Mod tools' })).toBeVisible();
  await expect(linked.getByRole('link', { name: 'Mod tools' })).toBeHidden();
  await expect(linked.locator('.muxui-disclosure__trigger-icon')).toBeVisible();
  expect(await linked.locator('.muxui-disclosure-group').screenshot()).toEqual(
    await reference.locator('.muxui-disclosure-group').screenshot(),
  );
  const before = await layout(page);

  release();
  await hydrated(page);
  expect(await layout(page)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { hydrationErrors: string[] }).hydrationErrors)).toEqual([]);
  expect(logs.hydrationProblems()).toEqual([]);

  const trigger = linked.getByRole('button', { name: 'Mod tools' });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(linked.getByRole('link', { name: 'Reports' })).toBeVisible();
  await reference.getByRole('button', { name: 'Mod tools' }).click();
  await expect(reference.getByRole('link', { name: 'Reports' })).toBeVisible();
  await page.mouse.move(0, 0);
  // Open, it still matches the reference: the stand-in link and label stay out of sight.
  await expect
    .poll(async () => (await box(linked.locator('.muxui-disclosure-group'))).height)
    .toBe((await box(reference.locator('.muxui-disclosure-group'))).height);
  await expect(linked.locator('.pb-linked-disclosure__open')).toBeHidden();
  await page.screenshot({ path: join(shots, 'linked-disclosure-on-open.png'), fullPage: true });

  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(linked.getByRole('link', { name: 'Reports' })).toBeHidden();
  await context.close();
});

test('scripts on, rendered open by the server: the trigger shows and closes it, the label does not', async ({ browser }) => {
  const { context, page, logs } = await open(browser, { path: '/?tools=1' });
  const linked = page.getByTestId('linked');
  const trigger = linked.getByRole('button', { name: 'Mod tools' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(linked.locator('.pb-linked-disclosure__label')).toBeHidden();
  await expect(linked.getByRole('link', { name: 'Reports' })).toBeVisible();
  expect(logs.hydrationProblems()).toEqual([]);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(linked.getByRole('link', { name: 'Reports' })).toBeHidden();
  await context.close();
});

test('scripts off, closed: a link stands in for the trigger, and following it opens the disclosure', async ({ browser }) => {
  const { context, page } = await open(browser, { js: false });
  const linked = page.getByTestId('linked');
  await expect(linked.getByRole('button', { name: 'Mod tools' })).toBeHidden();
  await expect(linked.getByRole('link', { name: 'Reports' })).toBeHidden();
  const standIn = linked.getByRole('link', { name: 'Mod tools' });
  await expect(standIn).toBeVisible();
  await expect(standIn).toHaveAttribute('href', '/?tools=1#mod-tools');
  await page.screenshot({ path: join(shots, 'linked-disclosure-off-closed.png'), fullPage: true });

  await standIn.click();
  await expect(page).toHaveURL(`${origin}/?tools=1#mod-tools`);
  await expect(page.locator('#mod-tools')).toHaveCount(1);
  await expect(linked.getByRole('link', { name: 'Reports' })).toBeVisible();
  await expect(linked.locator('.pb-linked-disclosure__label')).toHaveText('Mod tools');
  await expect(linked.locator('.pb-linked-disclosure__label')).toBeVisible();
  // Open, the trigger does not pretend to be collapsible: no button, no chevron.
  await expect(linked.getByRole('button', { name: 'Mod tools' })).toBeHidden();
  await expect(linked.locator('.muxui-disclosure__trigger-icon')).toBeHidden();
  await page.screenshot({ path: join(shots, 'linked-disclosure-off-open.png'), fullPage: true });
  await context.close();
});

test('scripts off, rendered open: a form inside posts and a link inside navigates', async ({ browser }) => {
  const { context, page } = await open(browser, { js: false, path: '/?tools=1' });
  const linked = page.getByTestId('linked');
  await linked.getByRole('textbox', { name: 'Note' }).fill('hello');
  await linked.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Posted note=hello&intent=save')).toBeVisible();

  await page.goto(`${origin}/?tools=1`);
  await linked.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(`${origin}/reports`);
  await expect(page.getByText('Page /reports')).toBeVisible();
  await context.close();
});

test('a long title wraps inside a 320px screen, scripts on and off, closed and open', async ({ browser }) => {
  const cases = [
    { js: true, path: '/', name: 'on-closed', title: (long: Locator) => long.getByRole('button') },
    { js: true, path: '/?ban=1', name: 'on-open', title: (long: Locator) => long.getByRole('button') },
    { js: false, path: '/', name: 'off-closed', title: (long: Locator) => long.getByRole('link') },
    { js: false, path: '/?ban=1', name: 'off-open', title: (long: Locator) => long.locator('.pb-linked-disclosure__label') },
  ];
  for (const { js, path, name, title } of cases) {
    const { context, page } = await open(browser, { js, path, width: 320 });
    const long = page.getByTestId('long');
    const element = title(long);
    await expect(element, name).toBeVisible();
    expect(await sideways(page), name).toBe(0);
    const column = await box(long);
    const own = await box(element);
    expect(own.x + own.width, name).toBeLessThanOrEqual(column.x + column.width + 0.5);
    // More than one line: the title wrapped instead of being clipped.
    const lines = await element.evaluate((node) => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight));
    expect(lines, name).toBeGreaterThan(1.5);
    expect(await element.evaluate((node) => node.scrollWidth - node.clientWidth), name).toBeLessThanOrEqual(0);
    await page.screenshot({ path: join(shots, `linked-disclosure-320-${name}.png`), fullPage: true });
    await context.close();
  }
});

/** The computed properties that make a Button look like one. */
const looks = [
  'display',
  'box-sizing',
  'width',
  'height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'gap',
  'border-top-left-radius',
  'border-bottom-right-radius',
  'border-top-width',
  'background-color',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-decoration-line',
  'white-space',
  'box-shadow',
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
  'cursor',
];
const look = (locator: Locator) =>
  locator.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, looks);

/** Keyboard focus, as a Tab gives it, so both :focus-visible and React Aria's focus-visible state apply. */
async function keyboardFocus(page: Page, locator: Locator) {
  await locator.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(locator).toBeFocused();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`ButtonLink computes the same as Mux Button at rest, hovered, pressed and focused (${scheme})`, async ({ browser }) => {
    const { context, page } = await open(browser, { path: `/?scheme=${scheme}`, scheme });
    await page.locator('.hx-buttons').screenshot({ path: join(shots, `button-link-${scheme}.png`) });
    for (const pair of await page.locator('[data-pair]').all()) {
      const name = await pair.getAttribute('data-pair');
      const button = pair.getByTestId('button');
      const link = pair.getByTestId('link');
      await expect(link).toHaveRole('link');
      expect(await look(link), `${name} at rest`).toEqual(await look(button));

      await button.hover();
      const hovered = await look(button);
      await link.hover();
      expect(await look(link), `${name} hovered`).toEqual(hovered);

      await button.hover();
      await page.mouse.down();
      const pressed = await look(button);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await link.hover();
      await page.mouse.down();
      const linkPressed = await look(link);
      // Let go away from the link, so the press does not follow it.
      await page.mouse.move(0, 0);
      await page.mouse.up();
      expect(linkPressed, `${name} pressed`).toEqual(pressed);
      expect(pressed['background-color'], `${name}: pressing changes the fill`).not.toBe(hovered['background-color']);

      await keyboardFocus(page, button);
      const focused = await look(button);
      await keyboardFocus(page, link);
      expect(await look(link), `${name} focused`).toEqual(focused);
      expect(focused['box-shadow'], `${name}: focus draws a ring`).not.toBe(hovered['box-shadow']);
      await page.locator('body').click({ position: { x: 1, y: 1 } });
    }
    await context.close();
  });
}

test('ButtonLink stays a link: it is followed without script and a modified click opens a new tab', async ({ browser }) => {
  const off = await open(browser, { js: false });
  await off.page.getByTestId('link').first().click();
  await expect(off.page).toHaveURL(`${origin}/submit`);
  await off.context.close();

  const on = await open(browser);
  const popup = on.context.waitForEvent('page');
  await on.page
    .getByTestId('link')
    .first()
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(await popup).toHaveURL(`${origin}/submit`);
  await expect(on.page).toHaveURL(`${origin}/`);
  await on.context.close();
});
