import { expect, test } from '@playwright/test';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// The shell server-renders in the request's locale and hydrates without a mismatch; the
// first click after the route-content marker works.
const cases = [
  { locale: 'en-US', sample: '1,234.5', pressed: (count: number) => `Pressed ${count} times`, press: 'Press' },
  { locale: 'de-DE', sample: '1.234,5', pressed: (count: number) => `${count}-mal gedrückt`, press: 'Drücken' },
] as const;

for (const { locale, sample, pressed, press } of cases) {
  test.describe(`shell in ${locale}`, () => {
    test.use({ locale, extraHTTPHeaders: { 'Accept-Language': `${locale},${locale.slice(0, 2)};q=0.9` } });

    test('the server renders the detected locale', async ({ request }) => {
      const html = await (await request.get('/')).text();
      expect(html).toMatch(new RegExp(`<html[^>]*\\slang="${locale}"`));
      expect(html).toContain(`data-testid="locale-sample">${sample}<`);
      expect(html).toContain(pressed(0));
    });

    test('/ hydrates without a mismatch and the first click after the marker works', async ({ page }) => {
      const log = recordConsole(page);
      await gotoHydrated(page, '/');
      await page.getByRole('button', { name: press }).click();
      await expect(page.getByTestId('press-count')).toHaveText(pressed(1));
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByTestId('locale-sample')).toHaveText(sample);
      await page.waitForLoadState('networkidle');
      expect(log.hydrationProblems()).toEqual([]);
      expect(log.problems()).toEqual([]);
    });
  });
}

test('/healthz answers without a database round trip', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('ok\n');
});

// Negative control: server HTML that differs from what the client renders must trip the
// detector, so a clean run above means something.
test('the detector catches a tampered server render', async ({ page }) => {
  await page.route('/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('data-testid="locale-sample">1,234.5<', 'data-testid="locale-sample">9,999.9<');
    await route.fulfill({ response, body });
  });
  const log = recordConsole(page);
  await page.goto('/');
  await page.locator('html[data-shell-hydrated="1"]').waitFor({ state: 'attached' });
  await expect.poll(() => log.hydrationProblems().length).toBeGreaterThan(0);
});
