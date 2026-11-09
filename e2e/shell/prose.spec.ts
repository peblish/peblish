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

test('a spoiler that holds a link stays a plain span with its own reveal control', async ({ page }) => {
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

  // A button inserted before the span reveals it without following the link, and only the button carries aria-pressed.
  const reveal = holder.locator('xpath=preceding-sibling::*[1]');
  await expect(reveal).toHaveRole('button');
  await expect(reveal).toHaveAccessibleName('Reveal spoiler');
  await expect(reveal).toHaveAttribute('aria-pressed', 'false');
  await reveal.focus();
  await page.keyboard.press('Enter');
  await expect(reveal).toHaveAttribute('aria-pressed', 'true');
  await expect(holder).toHaveAttribute('data-revealed', '');
  await expect(holder).not.toHaveAttribute('aria-pressed', /.*/);
  expect(page.url()).toMatch(/\/kit$/);
  await page.keyboard.press('Space');
  await expect(reveal).toHaveAttribute('aria-pressed', 'false');
  await expect(holder).not.toHaveAttribute('data-revealed', /.*/);

  // Clicking the text beside the link (not the link) reveals it too and keeps the control in step.
  await holder.click({ position: { x: 3, y: 5 } });
  await expect(reveal).toHaveAttribute('aria-pressed', 'true');
  await expect(holder).not.toHaveAttribute('aria-pressed', /.*/);
});

test('a spoiler holding another spoiler gets a reveal control, and only the inner leaf is a button', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const outer = page.getByTestId('kit-prose').locator('span.spoiler', { hasText: 'outer inner spoiler' });
  const inner = outer.locator('span.spoiler');
  // No button inside a button: the outer span is plain, the inner leaf is the button.
  await expect(outer).not.toHaveAttribute('role', 'button');
  await expect(outer).not.toHaveAttribute('tabindex', /.*/);
  await expect(outer).not.toHaveAttribute('aria-pressed', /.*/);
  await expect(inner).toHaveRole('button');
  await expect(inner).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('kit-prose').locator('span[role="button"] [role="button"]')).toHaveCount(0);

  const reveal = outer.locator('xpath=preceding-sibling::*[1]');
  await expect(reveal).toHaveRole('button');
  await reveal.click();
  await expect(reveal).toHaveAttribute('aria-pressed', 'true');
  await expect(outer).toHaveAttribute('data-revealed', '');
  // The inner spoiler is its own: the outer one revealed does not reveal it.
  await expect(inner).not.toHaveAttribute('data-revealed', /.*/);
  await expect(inner).toHaveAttribute('aria-pressed', 'false');
  await inner.focus();
  await page.keyboard.press('Enter');
  await expect(inner).toHaveAttribute('aria-pressed', 'true');
  await expect(outer).toHaveAttribute('data-revealed', '');
  await expect(reveal).toHaveAttribute('aria-pressed', 'true');
});

test('every inserted control is named, and none is added twice', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const controls = page.getByTestId('kit-prose').locator('button[data-spoiler-reveal]');
  // The link-holding spoiler and the outer of the nested pair.
  await expect(controls).toHaveCount(2);
  for (const control of await controls.all()) await expect(control).toHaveAccessibleName('Reveal spoiler');
});

test.describe('in German', () => {
  test.use({ locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE' } });

  test('the reveal control is named in the request locale', async ({ page }) => {
    await gotoHydrated(page, '/kit');
    await expect(page.getByTestId('kit-prose').locator('button[data-spoiler-reveal]').first()).toHaveAccessibleName('Spoiler anzeigen');
  });
});
