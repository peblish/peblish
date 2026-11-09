import { expect, test, type Browser } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gotoHydrated } from '../support/route-marker.ts';
import { budget, gzipSize, hasThemeRules, loadManifest, misplacedPackages, vendorKind } from './budget.ts';
import { routes } from './routes.ts';

// The payload budget as a check: each route's first visit, cold cache, must stay inside the
// numbers Andrew approved (budget.ts). Run against the production build; see routes.ts to add a page.

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
const fontFile = /\.(woff2?|ttf|otf)(\?|$)/;

interface Transfer {
  path: string;
  type: string;
  /** The body of a stylesheet, for the themes.css check. */
  text?: string;
  /** Bytes as a client would receive them: gzip -9 of text, the file itself for fonts. */
  bytes: number;
}

/** Visits `path` once with an empty cache and returns every same-origin response the page loaded. */
async function firstVisit(browser: Browser, origin: string, path: string, locale: string) {
  const context = await browser.newContext({ baseURL: origin, locale, extraHTTPHeaders: { 'Accept-Language': locale } });
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
    await page.waitForLoadState('networkidle');
    const muxHref = await page.locator('link#pb-mux-css').getAttribute('href');
    return { all: (await Promise.all(transfers)).filter((transfer) => transfer !== null), muxHref };
  } finally {
    await context.close();
  }
}

// A remote BASE_URL (a running server such as the Docker image) has no build output beside it.
const remote = Boolean(process.env.BASE_URL);

test('no vendor package sits outside its named chunk', () => {
  test.skip(remote, 'a remote BASE_URL has no build output beside it');
  // Throws, and so fails, when the build did not write a valid manifest: the guard never goes quiet.
  const manifest = loadManifest({ remote })!;
  expect(misplacedPackages(manifest)).toEqual([]);
  const files = manifest.chunks.map(({ file }) => file);
  // The named chunks exist at all, so a renamed group cannot make the rest of this check vacuous.
  expect(files.some((file) => vendorKind(file) === 'react')).toBe(true);
  expect(files.some((file) => vendorKind(file) === 'mux')).toBe(true);
});

for (const route of routes) {
  test(`${route.path} first visit is inside the budget`, async ({ browser, baseURL }) => {
    test.skip(Boolean(route.target) && Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
    const { all, muxHref } = await firstVisit(browser, new URL(baseURL!).origin, route.target?.() ?? route.path, 'en-US');
    const scripts = all.filter(({ path, type }) => path.endsWith('.js') && /javascript/.test(type));
    const sum = (list: Transfer[]) => list.reduce((total, { bytes }) => total + bytes, 0);

    // The figures go to the log on every run, so a drift shows before it breaks the budget.
    const figures = (list: Transfer[]) => kB(sum(list));
    // JavaScript: React and Mux UI by the vendor chunks' names; the app's own chunks are not counted.
    const vendor = scripts.filter(({ path }) => vendorKind(path) === 'react' || vendorKind(path) === 'mux');
    const editor = scripts.filter(({ path }) => vendorKind(path) === 'editor');
    expect(vendor.length, 'the React and Mux chunks load').toBeGreaterThan(1);
    expect(sum(vendor), `React and Mux UI JS ${kB(sum(vendor))}`).toBeLessThanOrEqual(budget.js);
    if (route.composer) expect(sum(editor), `the editor chunk ${kB(sum(editor))}`).toBeLessThanOrEqual(budget.editor);
    else
      expect(
        editor.map(({ path }) => path),
        'only the composer loads the editor',
      ).toEqual([]);

    // CSS: Mux UI's styles.css is its own stylesheet (the root route links it by id) and nothing else counts.
    expect(muxHref, 'the Mux UI stylesheet link').toBeTruthy();
    const mux = all.find(({ path }) => path === new URL(muxHref!, 'http://x').pathname);
    expect(mux, 'the Mux UI stylesheet loads').toBeDefined();
    expect(mux!.bytes, `Mux UI CSS ${kB(mux!.bytes)}`).toBeLessThanOrEqual(budget.css);
    expect(hasThemeRules(mux!.text ?? ''), 'themes.css rules are in the Mux UI stylesheet').toBe(false);
    expect(
      all.filter(({ text }) => hasThemeRules(text ?? '')).map(({ path }) => path),
      'no stylesheet carries themes.css rules',
    ).toEqual([]);

    // Fonts: the Latin slices only. A .ttf means a character no slice holds, which costs the full file.
    const fonts = all.filter(({ path }) => fontFile.test(path));
    expect(
      fonts.filter(({ path }) => path.endsWith('.ttf')).map(({ path }) => path),
      'no full font file',
    ).toEqual([]);
    expect(sum(fonts), `fonts ${kB(sum(fonts))}`).toBeLessThanOrEqual(budget.fonts);
    console.log(
      `payload ${route.path}: js ${figures(vendor)} of ${kB(budget.js)}, css ${kB(mux!.bytes)} of ${kB(budget.css)}, fonts ${figures(fonts)} of ${kB(budget.fonts)}${editor.length ? `, editor ${figures(editor)}` : ''}`,
    );
    if (route.fonts) expect(fonts.length, 'regular, italic and code faces are in use').toBeGreaterThanOrEqual(3);
  });
}

test('the font budget holds in German too (umlauts stay in the Latin slice)', async ({ browser, baseURL }) => {
  const kit = routes.find(({ fonts }) => fonts);
  test.skip(!kit, 'no route is marked for fonts');
  const { all } = await firstVisit(browser, new URL(baseURL!).origin, kit!.path, 'de-DE');
  const fonts = all.filter(({ path }) => fontFile.test(path));
  expect(fonts.filter(({ path }) => /ext|ttf|cyrillic|greek|vietnamese/.test(path))).toEqual([]);
  expect(fonts.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThanOrEqual(budget.fonts);
});

// Negative controls: the checks above must fail on what they exist to catch.
test.describe('the check catches', () => {
  test('themes.css rules in the Mux stylesheet', () => {
    const themes = readFileSync(join(import.meta.dirname, '../../packages/ui/node_modules/@muxui/react/generated/themes.css'), 'utf8');
    expect(hasThemeRules(themes)).toBe(true);
    const styles = readFileSync(join(import.meta.dirname, '../../packages/ui/node_modules/@muxui/react/generated/styles.css'), 'utf8');
    expect(hasThemeRules(styles)).toBe(false);
    // The whole of both files is about what a build with the themes imported would send.
    expect(gzipSize(Buffer.from(styles + themes))).toBeGreaterThan(budget.css);
  });

  test('a vendor package in an app chunk', () => {
    const vendorGroups = { 'vendor-react': '[\\\\/]node_modules[\\\\/](?:react|react-dom|scheduler)[\\\\/]' };
    const broken = {
      vendorGroups,
      chunks: [
        { file: 'assets/vendor-react-a.js', entry: false, packages: ['react', 'react-dom'], app: false },
        { file: 'assets/page-b.js', entry: false, packages: ['react-dom'], app: true },
      ],
    };
    expect(misplacedPackages(broken)).toEqual(['assets/page-b.js holds react-dom (a react package)']);
  });

  test('a missing or invalid manifest on a local run, and lets only a remote run go without', () => {
    const dir = mkdtempSync(join(tmpdir(), 'payload-manifest-'));
    try {
      const write = (name: string, text: string) => {
        const file = join(dir, name);
        writeFileSync(file, text);
        return file;
      };
      expect(() => loadManifest({ remote: false, path: join(dir, 'absent.json') })).toThrow(/did not write/);
      expect(() => loadManifest({ remote: false, path: write('broken.json', '{') })).toThrow();
      expect(() => loadManifest({ remote: false, path: write('shape.json', '{"vendorGroups":{},"chunks":[{"file":1}]}') })).toThrow(
        /not a manifest/,
      );
      const valid = {
        vendorGroups: { 'vendor-react': 'react' },
        chunks: [{ file: 'assets/vendor-react-a.js', entry: false, packages: ['react'], app: false }],
      };
      expect(loadManifest({ remote: false, path: write('valid.json', JSON.stringify(valid)) })).toEqual(valid);
      // Only a remote BASE_URL, which has no build output, may skip the guard.
      expect(loadManifest({ remote: true, path: join(dir, 'absent.json') })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
