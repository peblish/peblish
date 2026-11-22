import { expect, test, type BrowserContextOptions, type Locator } from '@playwright/test';
import { expectAccessible, expectAccessibleOnPhone } from '../auth/support.ts';
import { seedWorld, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { postFromPage, seedSafetyRows } from './support.ts';

// On a phone the Bans, Peers and Media tables and the report queue scroll inside their own card;
// the page itself never scrolls sideways. A visually hidden label in a Mux Table is absolutely
// positioned, so a card without its own positioning lets it escape and widen the page. The spec
// seeds every row it measures (a peer, a site ban, a blocked hash, a quarantined upload and a
// report), so it passes alone on an empty database and in any order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database and bucket for its seeds');

let world: World;
let session: BrowserContextOptions['storageState'];
test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  world = seedWorld();
  seedSafetyRows(world.admin.name);
  // One sign-in for the file: each one spends a one-time code, and a second in the same half minute waits for the next.
  const page = await browser.newPage();
  await signedInAdmin(page, world);
  const banned = await postFromPage(page, '/modlog/act', {
    intent: 'site_ban',
    person: world.spammer.actorId,
    reason: 'Narrow layout seed',
    public: 'on',
    duration: '7',
  });
  expect(banned.status, banned.body).toBe(200);
  // A Registration row whose label is one long word, the widest a cell gets.
  const invited = await postFromPage(page, '/admin/registration', {
    intent: 'create',
    label: `narrow-${'x'.repeat(48)}`,
    referrer: '',
    maxUses: '3',
    expires: 'never',
  });
  expect(invited.status, invited.body).toBe(200);
  session = await page.context().storageState();
  await page.context().close();
});

const pages = [
  '/admin/bans',
  '/admin/peers',
  '/admin/media?section=hashes',
  '/admin/media?section=review',
  '/admin/reports',
  '/admin/registration',
];

for (const width of [375, 320]) {
  test(`at ${width}px the admin safety pages do not scroll sideways`, async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await (await browser.newContext({ storageState: session, viewport: { width, height: 800 } })).newPage();
    for (const path of pages) {
      await gotoHydrated(page, path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const geometry = await page.evaluate(() => {
        const tables = [...document.querySelectorAll('main .muxui-table')].map((table) => {
          const card = table.parentElement!;
          const box = card.getBoundingClientRect();
          return { left: box.left, right: box.right, scrollsInside: card.scrollWidth > card.clientWidth };
        });
        window.scrollTo(10_000, 0);
        return { scroll: document.scrollingElement!.scrollWidth, scrolledBy: window.scrollX, width: window.innerWidth, tables };
      });
      expect(geometry.scroll, path).toBeLessThanOrEqual(geometry.width);
      expect(geometry.scrolledBy, path).toBe(0);
      // The review queue is a list, not a table: its seeded row is listed.
      if (path === '/admin/media?section=review') await expect(page.getByTestId('quarantine-row').first()).toBeVisible();
      else {
        expect(geometry.tables.length, path).toBeGreaterThan(0);
        expect(
          geometry.tables.every((box) => box.scrollsInside),
          path,
        ).toBe(true);
      }
      for (const box of geometry.tables) {
        expect(box.left, path).toBeGreaterThanOrEqual(0);
        expect(box.right, path).toBeLessThanOrEqual(geometry.width);
      }
      // A card that scrolls is a region named like its table, and a keyboard stop (TableCard).
      const grids = await page.getByRole('main').getByRole('grid').all();
      expect(grids.length, path).toBe(geometry.tables.length);
      for (const table of grids) {
        const name = await table.getAttribute('aria-label');
        const card = page.getByRole('region', { name: name!, exact: true });
        await expect(card, path).toHaveAttribute('tabindex', '0');
        await expect(card.getByRole('grid'), path).toHaveCount(1);
      }
    }
    await page.context().close();
  });
}

// The queue's card scrolls by keyboard on a phone; on a computer, where it fits, it is no stop.
test('the report queue’s card is a keyboard stop only while it scrolls', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 375, height: 800 } })).newPage();
  await gotoHydrated(page, '/admin/reports');
  const card = page.getByRole('region', { name: 'Reports', exact: true });
  await expect(card).toHaveAttribute('tabindex', '0');
  await card.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => card.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(card).not.toHaveAttribute('tabindex');
  // The server's page has no stop: the browser adds it when it measures.
  const plain = await (
    await browser.newContext({ storageState: session, viewport: { width: 375, height: 800 }, javaScriptEnabled: false })
  ).newPage();
  await plain.goto('/admin/reports');
  await expect(plain.getByRole('region', { name: 'Reports', exact: true })).not.toHaveAttribute('tabindex');
  await plain.context().close();
  await page.context().close();
});

// The staff pages in the Commons frame: the page's name is the h1 in the frame's view header, the admin
// tabs sit under it, and the rail holds the queue's communities and the modlog's filters beside a page
// wide enough for it (the queue's wide centre and the rail need a 1600px window with the sidebar open);
// where the rail gives way the modlog's filters show in the page.
test('the report queue and the modlog put their name in the view header and their places in the rail', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 1600, height: 900 } })).newPage();
  await gotoHydrated(page, '/admin/reports');
  await expect(page.getByRole('navigation', { name: 'Page' }).getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Reports' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The queue promises what it holds: reports, never held posts.
  await expect(page.getByRole('main')).not.toContainText(/held/i);
  const places = page.getByRole('complementary', { name: 'About this place' }).getByRole('region', { name: 'Communities with reports' });
  const first = places.getByRole('link').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/[?&]community=/);
  await expect(places.locator('a[aria-current="page"]')).toHaveCount(1);
  await expectAccessible(page);

  await gotoHydrated(page, '/modlog');
  await expect(page.getByRole('navigation', { name: 'Page' }).getByRole('heading', { level: 1, name: 'Modlog' })).toBeVisible();
  const rail = page.getByRole('complementary', { name: 'Filters' });
  await expect(rail.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main').getByRole('link', { name: /^All/ })).toBeHidden();
  await expectAccessible(page);

  // Narrower than the rail allows: the filters move into the page.
  await page.setViewportSize({ width: 960, height: 900 });
  await expect(rail).toBeHidden();
  await expect(page.getByRole('main').getByRole('region', { name: 'Filters' }).getByRole('link', { name: /^All/ })).toBeVisible();
  await page.context().close();
});

// The queue's inline filter follows the address: a community chosen in the rail shows in its select, so
// Apply keeps it rather than going back to All.
test('a community chosen in the queue’s rail is the inline filter’s choice, and Apply keeps it', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 1600, height: 900 } })).newPage();
  await gotoHydrated(page, '/admin/reports');
  const rail = page.getByRole('complementary', { name: 'About this place' }).getByRole('region', { name: 'Communities with reports' });
  const first = rail.getByRole('link').first();
  const handle = (await first.textContent())!.trim();
  await first.click();
  await expect(page).toHaveURL(/[?&]community=/);
  const community = new URL(page.url()).searchParams.get('community');
  const select = page.getByRole('main').getByRole('combobox', { name: 'Community' });
  await expect(select).toHaveValue(community!);
  await expect(select.locator('option:checked')).toHaveText(handle);
  await page.getByRole('main').getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/[?&]community=/);
  expect(new URL(page.url()).searchParams.get('community')).toBe(community);
  await page.context().close();
});

// At 1440 with the sidebar open the rail gives way (the queue's wide centre needs 1600): the inline filter
// is the way to choose a community there, and Apply keeps the choice.
test('at 1440px the queue’s inline filter chooses a community where the rail has given way', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 1440, height: 900 } })).newPage();
  await gotoHydrated(page, '/admin/reports');
  await expect(page.getByRole('complementary', { name: 'About this place' })).toBeHidden();
  const select = page.getByRole('main').getByRole('combobox', { name: 'Community' });
  await expect(select).toBeVisible();
  const choice = await select.locator('option').nth(1).getAttribute('value');
  await select.selectOption(choice!);
  await page.getByRole('main').getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/[?&]community=/);
  expect(new URL(page.url()).searchParams.get('community')).toBe(choice);
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Community' })).toHaveValue(choice!);
  await page.context().close();
});

// On a computer the page never scrolls sideways, and each staff table either sits whole or scrolls inside its
// card, a region named like its table that is a keyboard stop while it overflows (TableCard). With the sidebar
// following the window (open at 1440 and 1280, folded at 1100) every table sits whole in the centre. At 1100
// with the sidebar opened by hand the centre is narrower, and a table wider than it scrolls inside its card.
// The spec seeds every table but the site pages list, which may hold nothing yet. The fold follows the window
// from the page that is open when it narrows, and its cookie tells the server how to draw the next page, so
// each state waits for the cookie and every page is measured with the fold it calls for.
test('on a computer the page never scrolls sideways: the tables sit whole beside the sidebar as the window has it, and at 1100px beside the open sidebar a wider one scrolls in its named card, a keyboard stop', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 1440, height: 900 } })).newPage();
  const tables = {
    '/admin/bans': true,
    '/admin/peers': true,
    '/admin/reports': true,
    '/admin/media?section=hashes': true,
    // Pages are seeded in e2e/admin/staff-tables.serial.spec.ts: a fresh instance has none (pages.serial).
    '/admin/pages': false,
    '/admin/registration': true,
  };
  const fold = async () => (await page.context().cookies()).find((cookie) => cookie.name === 'peblish_side')?.value ?? '';
  /** The page's sideways overflow, and each table's card: how far it overflows, its role, its name and its stop. */
  const measure = () =>
    page.evaluate(() => ({
      page: document.scrollingElement!.scrollWidth - window.innerWidth,
      cards: [...document.querySelectorAll('main .muxui-table')].map((table) => {
        const card = table.parentElement!;
        return {
          over: card.scrollWidth - card.clientWidth,
          role: card.getAttribute('role'),
          named: Boolean(card.getAttribute('aria-label')),
          stop: card.getAttribute('tabindex'),
        };
      }),
    }));

  for (const width of [1440, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    // WIDE_AT in packages/web/src/shell/side-state.ts.
    await expect.poll(fold).toBe(width < 1264 ? 'narrow' : '');
    for (const [path, seeded] of Object.entries(tables)) {
      await gotoHydrated(page, path);
      const geometry = await measure();
      if (seeded) expect(geometry.cards.length, `${path} at ${width}px`).toBeGreaterThan(0);
      expect(geometry, `${path} at ${width}px`).toEqual({
        page: 0,
        cards: geometry.cards.map(() => ({ over: 0, role: 'region', named: true, stop: null })),
      });
    }
  }

  // At 1100 the sidebar opened by hand: the chosen fold is kept in the cookie, and the server draws each page open.
  await page.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await expect.poll(fold).toBe('open');
  let scrolled = 0;
  for (const [path, seeded] of Object.entries(tables)) {
    await gotoHydrated(page, path);
    await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute('aria-expanded', 'true');
    const geometry = await measure();
    if (seeded) expect(geometry.cards.length, `${path} open at 1100px`).toBeGreaterThan(0);
    expect(geometry, `${path} open at 1100px`).toEqual({
      page: 0,
      cards: geometry.cards.map(({ over }) => ({ over, role: 'region', named: true, stop: over > 0 ? '0' : null })),
    });
    const wide = geometry.cards.findIndex(({ over }) => over > 0);
    if (wide < 0) continue;
    scrolled += 1;
    // The arrow keys scroll it from its stop.
    const card = page.locator('main .muxui-table').nth(wide).locator('..');
    await card.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => card.evaluate((node) => node.scrollLeft), `${path} open at 1100px`).toBeGreaterThan(0);
  }
  expect(scrolled, 'a table wider than the centre beside the open sidebar').toBeGreaterThan(0);
  await page.context().close();
});

for (const width of [320, 390]) {
  test(`at ${width}px the queue rows’ Open, Show and details links are 44px targets`, async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await (await browser.newContext({ storageState: session, viewport: { width, height: 800 } })).newPage();
    await gotoHydrated(page, '/admin/reports');
    const links = page.locator('.rq-table').getByRole('link', { name: /^(Open|Show|Hide|Reporters and details)$/ });
    const sizes = await links.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { name: node.textContent, height: Math.round(box.height), width: Math.round(box.width) };
      }),
    );
    expect(sizes.map((size) => size.name)).toEqual(expect.arrayContaining(['Open', 'Show', 'Reporters and details']));
    expect(sizes.filter((size) => size.height < 44 || size.width < 44)).toEqual([]);
    await page.context().close();
  });
}

test('on a phone the admin tabs and the modlog filters are 44px targets', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 390, height: 844 } })).newPage();
  const shortest = (links: Locator) => links.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  await gotoHydrated(page, '/admin/bans');
  const tabs = await shortest(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link'));
  expect(tabs.length).toBeGreaterThan(1);
  expect(tabs.filter((height) => height < 44)).toEqual([]);
  await gotoHydrated(page, '/admin/reports');
  const queue = await shortest(
    page.getByRole('navigation', { name: 'Report queue' }).getByRole('link').or(page.locator('.rq-filter').locator('select, button')),
  );
  expect(queue.length).toBeGreaterThan(4);
  expect(queue.filter((height) => height < 44)).toEqual([]);
  await gotoHydrated(page, '/modlog');
  const filters = await shortest(page.getByRole('main').getByRole('region', { name: 'Filters' }).getByRole('link'));
  expect(filters.length).toBeGreaterThan(1);
  expect(filters.filter((height) => height < 44)).toEqual([]);
  await expectAccessibleOnPhone(page);
  await page.context().close();
});
