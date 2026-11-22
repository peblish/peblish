import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { skipWithoutKit } from '../support/kit.ts';

// The gallery (the G0 demo's home since lane UI) server-renders in the request's locale and
// hydrates without a mismatch; the first click after the route-content marker works. Every
// route type that exists also sets the marker and hydrates cleanly.
const cases = [
  { locale: 'en-US', sample: '1,234.5', pressed: (count: number) => `Pressed ${count} times`, press: 'Press' },
  { locale: 'de-DE', sample: '1.234,5', pressed: (count: number) => `${count}-mal gedrückt`, press: 'Drücken' },
] as const;

for (const { locale, sample, pressed, press } of cases) {
  test.describe(`gallery in ${locale}`, () => {
    test.use({ locale, extraHTTPHeaders: { 'Accept-Language': `${locale},${locale.slice(0, 2)};q=0.9` } });
    test.beforeEach(({ request }) => skipWithoutKit(request));

    test('the server renders the detected locale', async ({ request }) => {
      const html = await (await request.get('/kit')).text();
      expect(html).toMatch(new RegExp(`<html[^>]*\\slang="${locale}"`));
      expect(html).toContain(`data-testid="locale-sample">${sample}<`);
      expect(html).toContain(pressed(0));
    });

    test('/kit hydrates without a mismatch and the first click after the marker works', async ({ page }) => {
      const log = recordConsole(page);
      await gotoHydrated(page, '/kit');
      await page.getByRole('button', { name: press, exact: true }).click();
      await expect(page.getByTestId('press-count')).toHaveText(pressed(1));
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByTestId('locale-sample')).toHaveText(sample);
      await page.waitForLoadState('networkidle');
      expect(log.hydrationProblems()).toEqual([]);
      expect(log.problems()).toEqual([]);
    });
  });
}

// One of each route type that needs no sign-in: the home page, a form page and the 404 page.
for (const path of ['/', '/auth/sign-in', '/auth/sign-up', '/no-such-page']) {
  test(`${path} sets the hydration marker and hydrates cleanly`, async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, path);
    await expect(page.locator('html')).toHaveAttribute('data-shell-hydrated', '1');
    await page.waitForLoadState('networkidle');
    expect(log.hydrationProblems()).toEqual([]);
    expect(log.problems().filter(({ text }) => !text.includes('404'))).toEqual([]);
  });
}

test('/healthz answers without a database round trip', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('ok\n');
});

test('/kit answers 404 where the gallery is off, and the 404 page is the shell', async ({ request }) => {
  const kit = await request.get('/kit');
  test.skip(kit.status() !== 404, 'the gallery is on for this server');
  expect(await kit.text()).toContain('Page not found');
});

// Negative control: server HTML that differs from what the client renders must trip the
// detector, so a clean run above means something.
test('the detector catches a tampered server render', async ({ page, request }) => {
  await skipWithoutKit(request);
  await page.route('**/kit', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('data-testid="locale-sample">1,234.5<', 'data-testid="locale-sample">9,999.9<');
    await route.fulfill({ response, body });
  });
  const log = recordConsole(page);
  await page.goto('/kit');
  await page.locator('html[data-shell-hydrated="1"]').waitFor({ state: 'attached' });
  await expect.poll(() => log.hydrationProblems().length).toBeGreaterThan(0);
});

// Some browsers have no Intl.Segmenter (Firefox before 125, say). Nothing the shell loads may depend on it, or
// the whole page stays as the server drew it.
test('a browser without Intl.Segmenter hydrates the shell, avatars and all', async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(Intl, 'Segmenter'));
  const log = recordConsole(page);
  await gotoHydrated(page, '/');
  expect(await page.evaluate(() => 'Segmenter' in Intl)).toBe(false);
  expect(log.problems().filter(({ type }) => type === 'pageerror')).toEqual([]);
});

// An avatar's initial is made on the server and only drawn by the browser: where a runtime's Unicode data
// would make another one (a decomposed Hangul syllable, a letter with U+0897), the page keeps the server's.
test("a sidebar row's initial is the server's, kept by the browser, with no hydration mismatch", async ({ page }) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  const { password, people, initials } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts', 'initials'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string]; initials: { hangul: string; pepet: string } };
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');
  const expected = { hangul: '각', pepet: 'Aࢗ' };
  const selector = (name: string) => `a[href*="/c/${name}"] .muxui-avatar`;
  // The server's page, before any script runs.
  const served = await page.evaluate(
    async (selectors) => {
      const html = await (await fetch('/', { headers: { accept: 'text/html' } })).text();
      const page = new DOMParser().parseFromString(html, 'text/html');
      return selectors.map((one) => page.querySelector(one)?.textContent);
    },
    [selector(initials.hangul), selector(initials.pepet)],
  );
  expect(served).toEqual([expected.hangul, expected.pepet]);
  const log = recordConsole(page);
  await gotoHydrated(page, '/');
  await expect(page.locator(selector(initials.hangul)).first()).toHaveText(expected.hangul);
  await expect(page.locator(selector(initials.pepet)).first()).toHaveText(expected.pepet);
  await page.waitForLoadState('networkidle');
  expect(log.hydrationProblems()).toEqual([]);
});
