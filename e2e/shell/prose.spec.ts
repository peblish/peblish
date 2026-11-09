import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The rendered-content styles and Prose's behaviour on what the server pipeline emits. The
// gallery renders its bodies on the server (kit/-render.ts), so this is the real path.
test.beforeEach(({ request }) => skipWithoutKit(request));

const transparent = (colour: string) => colour === 'rgba(0, 0, 0, 0)' || colour === 'transparent';

test('the gallery shows output of the Markdown renderer and the sanitiser, not hand-written markup', async ({ request }) => {
  const html = await (await request.get('/kit')).text();
  // Only the sanitiser adds these.
  expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  expect(html).toContain('class="hljs-keyword"');
  expect(html).toContain('class="footnotes-sep"');
  expect(html).toContain('<span class="spoiler">hidden spoiler</span>');
});

test('a spoiler is reached with Tab and revealed with Enter or Space', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const prose = page.getByTestId('kit-prose');
  const spoiler = prose.getByRole('button', { name: 'hidden spoiler' });
  await expect(spoiler).toHaveAttribute('tabindex', '0');
  await expect(spoiler).toHaveAttribute('aria-pressed', 'false');
  expect(transparent(await spoiler.evaluate((node) => getComputedStyle(node).color))).toBe(true);

  // Tab from the last control before it in the page reaches the spoiler.
  await prose.locator('a.footnote-backref').focus();
  await page.keyboard.press('Tab');
  await expect(spoiler).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(spoiler).toHaveAttribute('aria-pressed', 'true');
  expect(transparent(await spoiler.evaluate((node) => getComputedStyle(node).color))).toBe(false);

  await page.keyboard.press('Space');
  await expect(spoiler).toHaveAttribute('aria-pressed', 'false');
  expect(transparent(await spoiler.evaluate((node) => getComputedStyle(node).color))).toBe(true);

  // A click still works, and keeps the pressed state in step.
  await spoiler.click();
  await expect(spoiler).toHaveAttribute('aria-pressed', 'true');
});

test('a spoiler that holds a link stays a plain span, and its link keeps its own key handling', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const holder = page.getByTestId('kit-prose').locator('span.spoiler', { hasText: 'linked word' });
  await expect(holder).not.toHaveAttribute('role', 'button');
  await expect(holder).not.toHaveAttribute('tabindex', /.*/);
  const link = holder.getByRole('link', { name: 'word' });
  // Blacked out like any spoiler, link included: the link does not show its accent colour.
  expect(transparent(await link.evaluate((node) => getComputedStyle(node).color))).toBe(true);
  // A keyboard user who tabs onto the link sees what they are about to follow.
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  expect(transparent(await link.evaluate((node) => getComputedStyle(node).color))).toBe(false);
});
