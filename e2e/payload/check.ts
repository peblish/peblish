import { expect, test, type Browser, type BrowserContextOptions } from '@playwright/test';
import { freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { budget, gzipSize, hasThemeRules, packSheetProblems, scriptLimit, scriptOver, vendorKind } from './budget.ts';
import { fixtures } from './fixtures.ts';
import type { PayloadRoute } from './routes.ts';

// A page's first visit and every budget check on it, for budget.spec.ts (the site as set) and brand.serial.spec.ts
// (under a brand pack). What is measured is compressible bytes: budget.spec.ts says how.
// A remote BASE_URL has no database to seed: the pages that need fixtures are skipped there.
const remote = Boolean(process.env.BASE_URL);

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

/** Report-only (CSS and the signed-out editor figure): an overrun is printed and noted on the test, never a failure. */
function reportOver(what: string, bytes: number, limit: number) {
  if (bytes <= limit) return;
  const note = `${what} ${kB(bytes)} is over its budget of ${kB(limit)} (report-only)`;
  console.log(`payload over: ${note}`);
  test.info().annotations.push({ type: 'payload-over', description: note });
}
export const fontFile = /\.(woff2?|ttf|otf)(\?|$)/;

interface Transfer {
  path: string;
  type: string;
  /** The body of a stylesheet, for the themes.css and brand pack checks. */
  text?: string;
  /** Bytes as a client would receive them: gzip -9 of text, the file itself for fonts. */
  bytes: number;
}

type StorageState = NonNullable<BrowserContextOptions['storageState']>;

/**
 * Visits `path` once with an empty cache (cookies aside) and returns every same-origin response the
 * page loaded. `shows`, when given, must be visible on the page before its responses are counted.
 */
export async function firstVisit(
  browser: Browser,
  origin: string,
  path: string,
  locale: string,
  { storageState, shows }: { storageState?: StorageState; shows?: RegExp } = {},
) {
  const context = await browser.newContext({ baseURL: origin, locale, extraHTTPHeaders: { 'Accept-Language': locale }, storageState });
  try {
    const page = await context.newPage();
    const transfers: Promise<Transfer | null>[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!response.ok() || url.origin !== origin) return;
      const type = response.headers()['content-type'] ?? '';
      transfers.push(
        response.body().then(
          (body) => ({
            path: url.pathname,
            type,
            ...(url.pathname.endsWith('.css') && { text: body.toString('utf8') }),
            bytes: fontFile.test(url.pathname) && !url.pathname.endsWith('.ttf') ? body.length : gzipSize(body),
          }),
          () => null,
        ),
      );
    });
    await gotoHydrated(page, path);
    if (shows) await expect(page.getByText(shows).first(), `the page shows ${shows}`).toBeVisible();
    await page.waitForLoadState('networkidle');
    const muxHref = await page.locator('link#pb-mux-css').getAttribute('href');
    const packHref = await page.evaluate(() => document.querySelector('link#pb-brand-css')?.getAttribute('href') ?? null);
    return { all: (await Promise.all(transfers)).filter((transfer) => transfer !== null), muxHref, packHref };
  } finally {
    await context.close();
  }
}

/** The admin the fixtures seeded, signed in once with their TOTP code; the session is reused by every signed-in page. */
let session: Promise<StorageState> | undefined;
function adminSession(browser: Browser, baseURL: string): Promise<StorageState> {
  session ??= (async () => {
    const { admin } = await fixtures(baseURL);
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await gotoHydrated(page, '/auth/sign-in');
      await signIn(page, `@${admin.name}`, admin.password);
      await landed(page, /\/auth\/two-factor/);
      await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
      await page.getByRole('button', { name: 'Verify' }).click();
      await landed(page, '/');
      return await context.storageState();
    } finally {
      await context.close();
    }
  })();
  return session;
}

/** Visits `route` once with an empty cache and checks every budget on what it loaded; with `pack`, also the brand pack's sheet. */
export async function checkFirstVisit(route: PayloadRoute, browser: Browser, baseURL: string, { pack = false } = {}): Promise<void> {
  test.skip(remote && Boolean(route.target ?? route.admin), 'needs the lane database for its seed (DATABASE_URL)');
  const origin = new URL(baseURL).origin;
  const path = (await route.target?.(origin)) ?? route.path;
  const { all, muxHref, packHref } = await firstVisit(browser, origin, path, 'en-US', {
    storageState: route.admin ? await adminSession(browser, origin) : undefined,
    shows: remote ? undefined : await route.shows?.(origin),
  });
  const scripts = all.filter(({ path, type }) => path.endsWith('.js') && /javascript/.test(type));
  const sum = (list: Transfer[]) => list.reduce((total, { bytes }) => total + bytes, 0);

  // The figures go to the log on every run, so a drift shows before it breaks the budget.
  const figures = (list: Transfer[]) => kB(sum(list));
  // JavaScript: React and Mux UI by the vendor chunks' names; the app's own chunks are not counted.
  const vendor = scripts.filter(({ path }) => vendorKind(path) === 'react' || vendorKind(path) === 'mux');
  const editor = scripts.filter(({ path }) => vendorKind(path) === 'editor');
  expect(vendor.length, 'the React and Mux chunks load').toBeGreaterThan(1);
  if (route.composer) reportOver(`${route.path}: the editor chunk`, sum(editor), budget.editor);
  else
    expect(
      editor.map(({ path }) => path),
      'only the composer loads the editor',
    ).toEqual([]);

  // CSS: Mux UI's styles.css is its own stylesheet (the root route links it by id) and nothing else counts.
  expect(muxHref, 'the Mux UI stylesheet link').toBeTruthy();
  const mux = all.find(({ path }) => path === new URL(muxHref!, 'http://x').pathname);
  expect(mux, 'the Mux UI stylesheet loads').toBeDefined();
  reportOver(`${route.path}: Mux UI CSS`, mux!.bytes, budget.css);
  expect(hasThemeRules(mux!.text ?? ''), 'themes.css rules are in the Mux UI stylesheet').toBe(false);
  expect(
    all.filter(({ text }) => hasThemeRules(text ?? '')).map(({ path }) => path),
    'no stylesheet carries themes.css rules',
  ).toEqual([]);
  // A brand pack's sheet, when site.brand names one: token overrides only (budget.ts), its size in the log.
  const packSheet = packHref ? all.find(({ path }) => path === new URL(packHref, 'http://x').pathname) : undefined;
  if (pack) {
    expect(packSheet, 'the brand pack stylesheet loads').toBeDefined();
    expect(packSheetProblems(packSheet!.text ?? ''), 'the brand pack stylesheet').toEqual([]);
    // So the wordmark's face is in the font figure below (it loads only where the wordmark shows).
    expect(
      all.some(({ path }) => /\/wordmark[^/]*\.woff2?$/.test(path)),
      "the pack's wordmark face loads",
    ).toBe(true);
  }

  // Fonts: the Latin slices only. A .ttf means a character no slice holds, which costs the full file.
  const fonts = all.filter(({ path }) => fontFile.test(path));
  expect(
    fonts.filter(({ path }) => path.endsWith('.ttf')).map(({ path }) => path),
    'no full font file',
  ).toEqual([]);
  expect(sum(fonts), `fonts ${kB(sum(fonts))}`).toBeLessThanOrEqual(budget.fonts);
  console.log(
    `payload ${route.path}${pack ? ' (brand pack)' : ''}: js ${figures(vendor)} of ${kB(scriptLimit(route.js))}, css ${kB(mux!.bytes)} of ${kB(budget.css)}, fonts ${figures(fonts)} of ${kB(budget.fonts)}${packSheet ? `, pack css ${kB(packSheet.bytes)}` : ''}${editor.length ? `, editor ${figures(editor)}` : ''}`,
  );
  // Chunk by chunk, largest first: where a shell or vendor change lands.
  const byChunk = (list: Transfer[]) =>
    [...list]
      .sort((a, b) => b.bytes - a.bytes)
      .map(({ path, bytes }) => `  ${kB(bytes).padStart(9)} ${path}`)
      .join('\n');
  // The home page's whole first-visit script (report only).
  if (route.path === '/')
    console.log(
      `payload / first-visit script: ${figures(scripts)} in ${scripts.length} files (React and Mux ${figures(vendor)})\n${byChunk(scripts)}`,
    );
  if (route.fonts) expect(fonts.length, 'regular, italic and code faces are in use').toBeGreaterThanOrEqual(3);
  // The script budget is checked last, once the figures are in the log; over it, the log also
  // lists the page's React and Mux chunks, to compare with a run of main.
  const limit = scriptLimit(route.js);
  if (sum(vendor) > limit) console.log(`payload ${route.path} React and Mux chunks:\n${byChunk(vendor)}`);
  expect(sum(vendor), scriptOver(route.path, sum(vendor), route.js)).toBeLessThanOrEqual(limit);
}
