import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { budget, gzipSize, vendorKind } from '../payload/budget.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { coldContext, seed, signedIn } from './support.ts';

// The composer's first visit against the payload budget (e2e/payload): the page signed in, which
// is what `/submit` is (signed out it is a redirect to sign-in), and the sheet's lazy code, which
// the budget allows to add up to budget.editor on top of the page it opens over. Measured cold,
// gzip -9, kB of 1,000 bytes, as budget.spec.ts does.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const fontFile = /\.(woff2?|ttf|otf)(\?|$)/;

interface Transfer {
  path: string;
  type: string;
  bytes: number;
}

/** Every same-origin response the page loads from now on, as a client would receive it. */
function recordTransfers(page: Page, origin: string) {
  const pending: Promise<Transfer | null>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!response.ok() || url.origin !== origin) return;
    pending.push(
      response.body().then(
        (body) => ({
          path: url.pathname,
          type: response.headers()['content-type'] ?? '',
          bytes: fontFile.test(url.pathname) && !url.pathname.endsWith('.ttf') ? body.length : gzipSize(body),
        }),
        () => null,
      ),
    );
  });
  return async () => (await Promise.all(pending)).filter((transfer) => transfer !== null);
}

const sum = (list: Transfer[]) => list.reduce((total, { bytes }) => total + bytes, 0);
const scripts = (list: Transfer[]) => list.filter(({ path, type }) => path.endsWith('.js') && /javascript/.test(type));

let context: BrowserContext;
let browser: Browser;
let origin: string;

test.beforeAll(async ({ browser: launched, baseURL }) => {
  browser = launched;
  origin = new URL(baseURL!).origin;
  const world = seed();
  context = await signedIn(browser, origin, world.people.poster, world.password);
});
test.afterAll(async () => {
  await context.close();
});

test('/submit first visit is inside the budget, and loads no editor chunk', async () => {
  const cold = await coldContext(browser, origin, context);
  const page = await cold.newPage();
  const transfers = recordTransfers(page, origin);
  await gotoHydrated(page, '/submit');
  await page.waitForLoadState('networkidle');
  const all = await transfers();
  const vendor = scripts(all).filter(({ path }) => vendorKind(path) === 'react' || vendorKind(path) === 'mux');
  const editor = scripts(all).filter(({ path }) => vendorKind(path) === 'editor');
  const muxHref = await page.locator('link#pb-mux-css').getAttribute('href');
  const mux = all.find(({ path }) => path === new URL(muxHref!, 'http://x').pathname);
  const fonts = all.filter(({ path }) => fontFile.test(path));
  console.log(
    `payload /submit (signed in): js ${kB(sum(vendor))} of ${kB(budget.js)}, editor ${kB(sum(editor))} of ${kB(budget.editor)}, fonts ${kB(sum(fonts))} of ${kB(budget.fonts)}, Mux UI CSS ${kB(mux?.bytes ?? 0)} of ${kB(budget.css)}`,
  );
  expect(mux, 'the Mux UI stylesheet loads').toBeDefined();
  expect(mux!.bytes, `Mux UI CSS ${kB(mux!.bytes)}`).toBeLessThanOrEqual(budget.css);
  expect(sum(vendor), `React and Mux UI JS ${kB(sum(vendor))}`).toBeLessThanOrEqual(budget.js);
  expect(sum(editor), 'the composer needs no rich-text editor').toBe(0);
  expect(fonts.filter(({ path }) => path.endsWith('.ttf')).map(({ path }) => path)).toEqual([]);
  expect(sum(fonts), `fonts ${kB(sum(fonts))}`).toBeLessThanOrEqual(budget.fonts);
  await cold.close();
});

test('the sheet loads its code only when it opens, and what it adds is inside the lazy budget', async () => {
  const cold = await coldContext(browser, origin, context);
  const page = await cold.newPage();
  const transfers = recordTransfers(page, origin);
  await gotoHydrated(page, '/');
  await page.waitForLoadState('networkidle');
  const before = await transfers();
  expect(
    before.filter(({ path }) => /\/assets\/(composer|composer-sheet|submit)-[\w-]+\.(js|css)$/.test(path)).map(({ path }) => path),
    'the page loads none of the sheet before it is opened',
  ).toEqual([]);
  await page.getByRole('link', { name: 'Create post' }).click();
  await page.getByRole('dialog', { name: 'Create post' }).getByLabel('Title').waitFor();
  await page.waitForLoadState('networkidle');
  const after = await transfers();
  const added = after.filter((transfer) => !before.includes(transfer));
  const addedScripts = scripts(added);
  console.log(
    `payload sheet: +${kB(sum(addedScripts))} of JS (${addedScripts.length} files) and +${kB(sum(added.filter(({ path }) => path.endsWith('.css'))))} of CSS when opened, of ${kB(budget.editor)}; page before ${kB(sum(scripts(before)))}`,
  );
  expect(sum(addedScripts), `the sheet's lazy JS ${kB(sum(addedScripts))}`).toBeLessThanOrEqual(budget.editor);
  expect(addedScripts.filter(({ path }) => vendorKind(path) === 'editor')).toEqual([]);
  await cold.close();
});
