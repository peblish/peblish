import { expect, test, type BrowserContextOptions } from '@playwright/test';
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
  session = await page.context().storageState();
  await page.context().close();
});

const pages = ['/admin/bans', '/admin/peers', '/admin/media?section=hashes', '/admin/media?section=review', '/admin/reports'];

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
    }
    await page.context().close();
  });
}
