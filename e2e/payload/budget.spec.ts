import { expect, test, type Browser, type BrowserContextOptions } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { budget, gzipSize, hasThemeRules, loadManifest, misplacedPackages, vendorKind } from './budget.ts';
import { fixtures } from './fixtures.ts';
import { notPages, routes, unaccounted } from './routes.ts';

// The payload budget as a check: each page's first visit, cold cache, must stay inside the
// numbers Andrew approved (budget.ts). Run against the production build; see routes.ts to add a page.
// During the Mux UI restyle the script and CSS sizes are report-only: they are measured and
// printed (and noted on the test when over), but do not fail. Fonts, the vendor placement, the
// editor's placement and the themes.css rule still fail. PAYLOAD.md has the figures; the budget
// is set again when the restyle lands.
//
// What is measured is compressible bytes: every text file is gzipped here (level 9), as a
// compressing proxy would send it. Nothing in this repository compresses responses (the Node
// server sends them as they are); in production Traefik (Easypanel) or Cloudflare does, which
// deploy/README.md notes. Fonts are woff2, already compressed, and count as sent.
// A remote BASE_URL has no build output and no database to seed: the manifest check and the
// pages that need fixtures are skipped there, and nothing else is.
const remote = Boolean(process.env.BASE_URL);
test.setTimeout(90_000);

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

/** Report-only during the restyle: an overrun is printed and noted on the test, never a failure. */
function reportOver(what: string, bytes: number, limit: number) {
  if (bytes <= limit) return;
  const note = `${what} ${kB(bytes)} is over its budget of ${kB(limit)} (report-only during the Mux UI restyle)`;
  console.log(`payload over: ${note}`);
  test.info().annotations.push({ type: 'payload-over', description: note });
}
const fontFile = /\.(woff2?|ttf|otf)(\?|$)/;

interface Transfer {
  path: string;
  type: string;
  /** The body of a stylesheet, for the themes.css check. */
  text?: string;
  /** Bytes as a client would receive them: gzip -9 of text, the file itself for fonts. */
  bytes: number;
}

type StorageState = NonNullable<BrowserContextOptions['storageState']>;

/**
 * Visits `path` once with an empty cache (cookies aside) and returns every same-origin response the
 * page loaded. `shows`, when given, must be visible on the page before its responses are counted.
 */
async function firstVisit(
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
    return { all: (await Promise.all(transfers)).filter((transfer) => transfer !== null), muxHref };
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

test('every page of the app is budgeted or says why it has no payload', () => {
  // routeTree.gen.ts is generated by pnpm gen and pnpm build; its FileRoutesByFullPath lists every file route.
  const tree = readFileSync(join(import.meta.dirname, '../../packages/web/src/routeTree.gen.ts'), 'utf8');
  const block = /interface FileRoutesByFullPath \{([^}]*)\}/.exec(tree)?.[1];
  expect(block, 'FileRoutesByFullPath in routeTree.gen.ts').toBeTruthy();
  const inventory = [...block!.matchAll(/^\s*'([^']+)':/gm)].map(([, route]) => route!);
  expect(inventory.length, 'the inventory is not empty').toBeGreaterThan(10);

  expect(
    unaccounted(inventory),
    'file routes in neither routes (budgeted) nor notPages (no payload): add them in e2e/payload/routes.ts',
  ).toEqual([]);
  // A renamed or deleted route must not leave its entry behind.
  expect([...routes.map(({ route }) => route), ...Object.keys(notPages)].filter((route) => !inventory.includes(route))).toEqual([]);
});

for (const route of routes) {
  test(`${route.path} first visit is inside the budget`, async ({ browser, baseURL }) => {
    test.skip(remote && Boolean(route.target ?? route.admin), 'needs the lane database for its seed (DATABASE_URL)');
    const origin = new URL(baseURL!).origin;
    const path = (await route.target?.(origin)) ?? route.path;
    const { all, muxHref } = await firstVisit(browser, origin, path, 'en-US', {
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
    reportOver(`${route.path}: React and Mux UI JS`, sum(vendor), route.js ?? budget.js);
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

    // Fonts: the Latin slices only. A .ttf means a character no slice holds, which costs the full file.
    const fonts = all.filter(({ path }) => fontFile.test(path));
    expect(
      fonts.filter(({ path }) => path.endsWith('.ttf')).map(({ path }) => path),
      'no full font file',
    ).toEqual([]);
    expect(sum(fonts), `fonts ${kB(sum(fonts))}`).toBeLessThanOrEqual(budget.fonts);
    console.log(
      `payload ${route.path}: js ${figures(vendor)} of ${kB(route.js ?? budget.js)}, css ${kB(mux!.bytes)} of ${kB(budget.css)}, fonts ${figures(fonts)} of ${kB(budget.fonts)}${editor.length ? `, editor ${figures(editor)}` : ''}`,
    );
    // The home page's whole first-visit script, chunk by chunk (report only): where a shell or vendor change lands.
    if (route.path === '/') {
      const byChunk = [...scripts].sort((a, b) => b.bytes - a.bytes).map(({ path, bytes }) => `  ${kB(bytes).padStart(9)} ${path}`);
      console.log(
        `payload / first-visit script: ${figures(scripts)} in ${scripts.length} files (React and Mux ${figures(vendor)})\n${byChunk.join('\n')}`,
      );
    }
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
// The groups as vite.config.ts writes them (the patterns' source text).
const validGroups = {
  'vendor-react': '[\\\\/]node_modules[\\\\/](?:react|react-dom|scheduler)[\\\\/]',
  'vendor-mux': '[\\\\/]node_modules[\\\\/](?:@muxui[\\\\/]react|react-aria)[\\\\/]',
  'vendor-editor': '[\\\\/]node_modules[\\\\/](?:@tiptap|prosemirror-[\\w-]+)[\\\\/]',
};

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
    const broken = {
      vendorGroups: validGroups,
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
      const chunks = [{ file: 'assets/vendor-react-a.js', entry: false, packages: ['react'], app: false }];
      const invalid = {
        'chunk shape': { vendorGroups: validGroups, chunks: [{ file: 1 }] },
        'no groups': { vendorGroups: {}, chunks },
        'groups as an array': { vendorGroups: [], chunks },
        'groups as an array of the right patterns': { vendorGroups: Object.values(validGroups), chunks },
        'a missing group': {
          vendorGroups: { 'vendor-react': validGroups['vendor-react'], 'vendor-mux': validGroups['vendor-mux'] },
          chunks,
        },
        'an unexpected group': { vendorGroups: { ...validGroups, 'vendor-extra': 'extra' }, chunks },
        'a pattern that does not compile': { vendorGroups: { ...validGroups, 'vendor-react': '(' }, chunks },
        'a pattern that matches nothing': { vendorGroups: { ...validGroups, 'vendor-react': '(?!)' }, chunks },
        'a pattern that is not a string': { vendorGroups: { ...validGroups, 'vendor-mux': 1 }, chunks },
        'no chunks': { vendorGroups: validGroups },
      };
      for (const [reason, manifest] of Object.entries(invalid)) {
        expect(() => loadManifest({ remote: false, path: write('invalid.json', JSON.stringify(manifest)) }), reason).toThrow(
          /not a manifest/,
        );
      }
      const valid = { vendorGroups: validGroups, chunks };
      expect(loadManifest({ remote: false, path: write('valid.json', JSON.stringify(valid)) })).toEqual(valid);
      // Only a remote BASE_URL, which has no build output, may skip the guard.
      expect(loadManifest({ remote: true, path: join(dir, 'absent.json') })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('a page that is neither budgeted nor excused', () => {
    // A route that can never be a real page, so the example stays unbudgeted as pages are added.
    expect(unaccounted(['/', '/auth/sign-in', '/healthz', '/nonexistent/'])).toEqual(['/nonexistent/']);
  });
});
