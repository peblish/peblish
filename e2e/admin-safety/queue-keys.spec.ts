import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { postsTo } from './support.ts';

// The report queue keeps its forms in Mux Table rows, and Mux Table is a React Aria grid that
// takes arrow keys, Tab and typed letters (type-ahead) for itself. queue.tsx keeps those keys
// from the grid while focus is in a field of a row; this checks fields behave as fields, and that
// its window listener goes when the queue does.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
// Each test signs in and walks several pages; other lanes share this machine, so allow for load.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

type Seed = { password: string; moderator: { name: string }; titles: Record<'hate' | 'remove' | 'escalate' | 'dismiss', string> };
const root = join(import.meta.dirname, '../..');
let seed: Seed;
test.beforeAll(() => {
  seed = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Seed;
});

const row = (page: Page, title: string) => page.locator('tbody tr', { hasText: title });

/** Counts the queue's own keydown listeners on window (their code names `.rq-table`), from before the page's scripts run. */
async function watchQueueListeners(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Set<unknown>();
    Object.assign(window, { queueListeners: () => listeners.size });
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'keydown' && String(listener).includes('rq-table')) listeners.add(listener);
      add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'keydown') listeners.delete(listener);
      remove(type, listener, options);
    }) as typeof window.removeEventListener;
  });
}
const queueListeners = (page: Page) => page.evaluate(() => (window as unknown as { queueListeners: () => number }).queueListeners());

test('typing in a row’s fields acts as in any field, and the key listener leaves with the queue', async ({ page }) => {
  await watchQueueListeners(page);
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.moderator.name}`, seed.password);
  await landed(page, '/');
  await gotoHydrated(page, '/admin/reports');
  expect(await queueListeners(page)).toBe(1);

  const hate = row(page, seed.titles.hate);
  const note = hate.getByRole('textbox', { name: 'Note' });
  await note.click();
  await page.keyboard.type('abc');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  await expect(note).toHaveValue('abXc');
  // Letters that begin other rows (Mux Table's type-ahead would jump there) are typed in the field.
  await page.keyboard.press('ArrowRight');
  const other = seed.titles.remove.slice(0, 6);
  await page.keyboard.type(other);
  await expect(note).toHaveValue(`abXc${other}`);
  // The grid's other keys stay in the field too (where they move the caret is the platform's).
  for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
    await page.keyboard.press(key);
    await expect(note, key).toBeFocused();
  }
  await expect(note).toHaveValue(`abXc${other}`);
  // Tab goes to the next control in the row and Shift+Tab to the one before, as in any form.
  await page.keyboard.press('Tab');
  await expect(hate.getByRole('button', { name: 'Resolve' })).toBeFocused();
  await note.click();
  await page.keyboard.press('Shift+Tab');
  await expect(note).not.toBeFocused();
  expect(await hate.evaluate((cell) => cell.contains(document.activeElement) && document.activeElement !== document.body)).toBe(true);

  // The removal form's explanation: arrows move the caret and Enter is a new line, not a post.
  const remove = row(page, seed.titles.remove);
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  const explanation = remove.getByLabel('Explanation');
  const sent = postsTo(page, '/admin/reports');
  await explanation.click();
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await expect(explanation).toHaveValue('aXb\ntwo');
  await page.waitForTimeout(500);
  expect(sent).toHaveLength(0);

  // Enter in a note resolves the group: Resolve is the form's first button (accepted, not a hazard).
  const dismiss = row(page, seed.titles.dismiss);
  await dismiss.getByRole('textbox', { name: 'Note' }).fill('Handled in chat');
  await dismiss.getByRole('textbox', { name: 'Note' }).press('Enter');
  await expect(row(page, seed.titles.dismiss)).toHaveCount(0, { timeout: 15_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.get('intent')).toBe('resolve');
  expect(sent[0]!.get('note')).toBe('Handled in chat');

  // Leaving the queue in the browser (a client-side navigation) removes its listener.
  await row(page, seed.titles.hate).getByRole('link', { name: /^!/ }).click();
  await expect(page).not.toHaveURL(/\/admin\/reports/);
  await expect(page.locator('tbody tr')).toHaveCount(0);
  expect(await queueListeners(page)).toBe(0);
});
