import { expect, test } from '@playwright/test';
import { GATE_PATHS, artifactPath, recordConsole, slug, writeArtifact } from './support';

// Criterion (a): no React hydration mismatch, for both gate variants and two locales.
for (const locale of ['en-US', 'de-DE'] as const) {
  test.describe(`hydration (${locale})`, () => {
    test.use({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });

    for (const path of GATE_PATHS) {
      test(`${path} hydrates without a mismatch`, async ({ page }, info) => {
        const log = recordConsole(page);
        await page.goto(path);
        await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
        // Give late recoverable errors (Suspense boundaries, effects) time to surface.
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1_000);
        await page.screenshot({ path: artifactPath('screens', `${slug(info)}.png`), fullPage: true });
        log.save(slug(info));
        writeArtifact(`problems/${slug(info)}.json`, log.problems());
        // What the client renders once hydrated, beside the server facts in ssr-*.json.
        const client = await page.evaluate(() => {
          const markdown = document.querySelector('.muxui-markdown');
          return {
            virtualizerRows: document.querySelectorAll('.muxui-virtualizer [role="option"]').length,
            markdown: {
              table: markdown?.querySelector('table') !== null,
              strikethrough: markdown?.querySelector('del, s') !== null,
              codeBlock: markdown?.querySelector('pre') !== null,
              highlightedTokens: markdown?.querySelector('pre span[style*="color"]') !== null,
              html: markdown?.innerHTML,
            },
          };
        });
        writeArtifact(`facts/client-${slug(info)}.json`, client);
        expect(log.hydrationProblems()).toEqual([]);
        expect(client.virtualizerRows).toBeGreaterThan(0);
      });
    }
  });
}

// Provider placement (RAC 7474): I18nProvider around the root Outlet sits outside TanStack
// Router's route Suspense boundary, so any update it makes during hydration reaches a
// boundary that has not hydrated yet.
test.describe('I18nProvider around the root Outlet (de-DE)', () => {
  test.use({ locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE' } });

  for (const mode of ['root-locale', 'root-default'] as const) {
    test(mode, async ({ page, request }, info) => {
      const html = await (await request.get(`/gate-plain?i18n=${mode}`)).text();
      const serverNumber = /data-testid="number-field">[\s\S]*?<input[^>]*\svalue="([^"]*)"/.exec(html)?.[1];
      const log = recordConsole(page);
      await page.goto(`/gate-plain?i18n=${mode}`);
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1_000);
      log.save(slug(info));
      const settledNumber = await page.getByTestId('number-field').locator('input').inputValue();
      writeArtifact(`facts/${slug(info)}.json`, { mode, serverNumber, settledNumber, problems: log.problems() });
      expect(log.hydrationProblems()).toEqual([]);
      expect(settledNumber).toBe('1.234,50 €');
      // With a locale the server already renders German; without one RAC renders en-US until hydrated.
      expect(serverNumber).toBe(mode === 'root-locale' ? '1.234,50 €' : '€1,234.50');
    });
  }
});

// Negative control: a route that renders different text on server and client must trip the detector.
test('the detector catches a deliberate mismatch', async ({ page }, info) => {
  const log = recordConsole(page);
  await page.goto('/mismatch-probe');
  await page.locator('html[data-shell-hydrated="1"]').waitFor({ state: 'attached' });
  await page.waitForTimeout(500);
  log.save(slug(info));
  expect(log.hydrationProblems().length).toBeGreaterThan(0);
});
