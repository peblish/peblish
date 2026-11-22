import { test } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { readSetting } from '../../packages/core/src/settings/read.ts';
import { seedSetting } from '../../packages/core/src/testing/seed-a.ts';
import type { SiteBrand } from '../../packages/schema/src/site-settings.ts';
import { checkFirstVisit } from './check.ts';
import { routes } from './routes.ts';

// The payload budget under the feddit brand pack: its sheet, its icons and, in the desktop header, its wordmark's
// face on top of each page's own payload. The pack adds the same files to every page, so this measures the page
// with the most fonts (the gallery) and the home page. Run against the production build, like budget.spec.ts.
// It saves site.brand and site.name (the wordmark shows only beside a name that holds it), which every page reads,
// so it is a serial spec, and it puts both back after.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database to set site.brand (DATABASE_URL)');
test.setTimeout(90_000);
test.describe.configure({ mode: 'serial' });

let saved: { brand: SiteBrand; name: string } | undefined;
test.beforeAll(async () => {
  saved = { brand: await readSetting('site.brand'), name: await readSetting('site.name') };
  await seedSetting('site.brand', 'feddit');
  await seedSetting('site.name', 'Feddit');
});
test.afterAll(async () => {
  if (saved) {
    await seedSetting('site.brand', saved.brand);
    await seedSetting('site.name', saved.name);
  }
  await closePools();
});

for (const route of routes.filter(({ path, fonts }) => fonts || path === '/')) {
  test(`${route.path} first visit under the feddit pack is inside the budget`, ({ browser, baseURL }) =>
    checkFirstVisit(route, browser, baseURL!, { pack: true }));
}
