import { expect, test, type BrowserContextOptions } from '@playwright/test';
import { postFromPage } from '../admin-safety/support.ts';
import { seedWorld, signedInAdmin } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The site pages table, populated, at the widths e2e/admin-safety/narrow.spec.ts holds the other staff
// tables to: on a phone it scrolls inside its card, a named region and a keyboard stop, and the page never
// scrolls sideways; on a computer it sits whole in the centre. Serial, after pages.serial.spec.ts: adding
// the shipped drafts is a site-wide change, and that spec starts from a fresh instance with no pages.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let session: BrowserContextOptions['storageState'];
test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await browser.newPage();
  await signedInAdmin(page, seedWorld());
  // Adds whichever shipped drafts are missing (none, after pages.serial.spec.ts).
  const seeded = await postFromPage(page, '/admin/pages', { intent: 'seed' });
  expect(seeded.status, seeded.body).toBe(200);
  session = await page.context().storageState();
  await page.context().close();
});

for (const width of [375, 320]) {
  test(`at ${width}px the site pages table scrolls inside its named card`, async ({ browser }) => {
    const page = await (await browser.newContext({ storageState: session, viewport: { width, height: 800 } })).newPage();
    await gotoHydrated(page, '/admin/pages');
    const card = page.getByRole('region', { name: 'Pages', exact: true });
    await expect(card.getByRole('grid', { name: 'Pages' })).toBeVisible();
    await expect(card).toHaveAttribute('tabindex', '0');
    const geometry = await page.evaluate(() => {
      const table = document.querySelector('main .muxui-table')!.parentElement!;
      const box = table.getBoundingClientRect();
      return {
        page: document.scrollingElement!.scrollWidth - window.innerWidth,
        inside: table.scrollWidth > table.clientWidth,
        right: box.right,
      };
    });
    expect(geometry).toEqual({ page: 0, inside: true, right: expect.any(Number) });
    expect(geometry.right).toBeLessThanOrEqual(width);
    await page.context().close();
  });
}

test('on a computer the site pages table sits whole in the centre', async ({ browser }) => {
  const page = await (await browser.newContext({ storageState: session, viewport: { width: 1440, height: 900 } })).newPage();
  const fold = async () => (await page.context().cookies()).find((cookie) => cookie.name === 'peblish_side')?.value ?? '';
  for (const width of [1440, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    // The sidebar folds below WIDE_AT (shell/side-state.ts) from the open page; the next is drawn so.
    await expect.poll(fold).toBe(width < 1264 ? 'narrow' : '');
    await gotoHydrated(page, '/admin/pages');
    const card = page.getByRole('region', { name: 'Pages', exact: true });
    await expect(card.getByRole('grid')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const table = document.querySelector('main .muxui-table')!.parentElement!;
      return { page: document.scrollingElement!.scrollWidth - window.innerWidth, card: table.scrollWidth - table.clientWidth };
    });
    expect(geometry, `at ${width}px`).toEqual({ page: 0, card: 0 });
    await expect(card, `at ${width}px`).not.toHaveAttribute('tabindex');
  }
  await page.context().close();
});
