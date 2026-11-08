import { expect, test } from '@playwright/test';
import { artifactPath, gotoHydrated, recordConsole, slug, writeArtifact } from './support';

// Criterion (e): the server HTML carries the theme scope, and light/dark toggles after hydration.
test('theme scope is server-rendered and toggles after hydration', async ({ page, request }, info) => {
  const html = await (await request.get('/gate')).text();
  const htmlTag = /<html[^>]*>/.exec(html)?.[0] ?? '';
  expect(htmlTag).toContain('data-muxui-theme="standard-harbour"');
  expect(htmlTag).toContain('data-muxui-color-scheme="light"');
  expect(html).toContain('data-muxui-theme="standard-lagoon" data-muxui-color-scheme="dark"');

  const log = recordConsole(page);
  await gotoHydrated(page, '/gate');
  const root = page.locator('html');
  const colors = () =>
    page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      nested: getComputedStyle(document.querySelector('[data-testid="nested-dark-scope"]')!).backgroundColor,
      button: getComputedStyle(document.querySelector('.muxui-button')!).backgroundColor,
    }));

  const light = await colors();
  await page.screenshot({ path: artifactPath('screens', `${slug(info)}-light.png`) });

  // The first interaction after hydration: the switch's label.
  await page.locator('.muxui-color-mode-toggle').click();
  await expect(root).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await expect.poll(async () => (await colors()).body).not.toBe(light.body);
  const dark = await colors();
  await page.screenshot({ path: artifactPath('screens', `${slug(info)}-dark.png`) });

  await page.locator('.muxui-color-mode-toggle').click();
  await expect(root).toHaveAttribute('data-muxui-color-scheme', 'light');
  await expect.poll(async () => (await colors()).body).toBe(light.body);

  log.save(slug(info));
  writeArtifact(`facts/${slug(info)}.json`, { htmlTag, light, dark });
  expect(light.nested).not.toBe(light.body);
  expect(log.hydrationProblems()).toEqual([]);
});
