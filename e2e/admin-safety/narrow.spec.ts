import { expect, test } from '@playwright/test';
import { seedWorld, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// On a phone the Bans, Peers and Media tables and the report queue scroll inside their own card;
// the page itself never scrolls sideways. A visually hidden label in a Mux Table is absolutely
// positioned, so a card without its own positioning lets it escape and widen the page.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

const pages = ['/admin/bans', '/admin/peers', '/admin/media?section=hashes', '/admin/media?section=review', '/admin/reports'];

for (const width of [375, 320]) {
  test(`at ${width}px the admin safety pages do not scroll sideways`, async ({ page }) => {
    test.setTimeout(90_000);
    await signedInAdmin(page, world);
    await page.setViewportSize({ width, height: 800 });
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
      if (path !== '/admin/media?section=review') {
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
  });
}
