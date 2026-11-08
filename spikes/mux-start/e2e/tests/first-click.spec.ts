import { expect, test, type Page } from '@playwright/test';
import { GATE_PATHS, artifactPath, gotoHydrated, recordConsole, slug, writeArtifact } from './support';

// Criterion (b): each test loads a fresh page, waits only for the hydration marker, and
// makes its first interaction at once. A swallowed first click (RAC 8239) would leave the
// asserted state unset, and the expectation fails within its timeout without a retry click.

const interactions: Record<string, (page: Page) => Promise<void>> = {
  async 'table row selects'(page) {
    const row = page.locator('.muxui-table__row').nth(2);
    await row.locator('.muxui-table__cell').first().click();
    await expect(row).toHaveAttribute('data-muxui-state-selected');
    await expect(page.getByTestId('table-selection')).toHaveText('row-3');
  },
  async 'dialog opens'(page) {
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Gate dialog' })).toBeVisible();
  },
  async 'menu opens and an item is chosen'(page) {
    await page.getByRole('button', { name: 'Post actions' }).click();
    await expect(page.getByRole('menu', { name: 'Post actions' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Save' }).click();
    await expect(page.getByTestId('menu-action')).toHaveText('save');
    await expect(page.getByRole('menu')).toBeHidden();
  },
  async 'tabs switch'(page) {
    const tab = page.getByRole('tab', { name: 'New' });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toHaveAttribute('data-muxui-state-selected');
    await expect(page.getByRole('tabpanel')).toHaveText('New posts panel');
  },
  async 'text editor takes typing'(page) {
    const editable = page.locator('.muxui-text-editor [contenteditable="true"]');
    await editable.click();
    await page.keyboard.type('Hello gate');
    await expect(editable).toHaveText('Hello gate');
    await expect(page.getByTestId('editor-text')).toHaveText('Hello gate');
  },
  async 'toast shows'(page) {
    await page.getByRole('button', { name: 'Show toast' }).click();
    await expect(page.getByText('Saved from the gate')).toBeVisible();
  },
  async 'button activates'(page) {
    await page.getByRole('button', { name: 'Count clicks' }).click();
    await expect(page.getByTestId('click-count')).toHaveText('1');
  },
  async 'select opens and picks'(page) {
    await page.locator('.muxui-select__trigger').click();
    await page.getByRole('option', { name: 'linux' }).click();
    await expect(page.locator('.muxui-select__value')).toHaveText('linux');
  },
  async 'tooltip opens on hover'(page) {
    // RAC opens a tooltip on hover only once a pointermove has set pointer modality. A
    // one-step Playwright hover on a fresh page enters the trigger before any pointermove,
    // which no real mouse does, so move the pointer once first.
    await page.mouse.move(1, 1);
    await page.getByRole('button', { name: 'Hover for help' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Tooltip content');
  },
};

// CPU x6 widens the window between first paint and hydration, where a swallowed first
// click would show up.
for (const cpu of [1, 6]) for (const path of GATE_PATHS) {
  test.describe(`first interaction after hydration on ${path} (cpu x${cpu})`, () => {
    test.beforeEach(async ({ page }) => {
      if (cpu === 1) return;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    });

    for (const [name, interact] of Object.entries(interactions)) {
      test(name, async ({ page }, info) => {
        const log = recordConsole(page);
        const marker = await gotoHydrated(page, path);
        try {
          await interact(page);
        } finally {
          await page.screenshot({ path: artifactPath('screens', `${slug(info)}.png`) });
          log.save(slug(info));
          writeArtifact(`markers/${slug(info)}.json`, marker);
        }
        expect(log.hydrationProblems()).toEqual([]);
      });
    }

    // The same interactions back to back on one page, as a user would make them.
    test('all interactions in sequence', async ({ page }, info) => {
      const log = recordConsole(page);
      await gotoHydrated(page, path);
      await interactions['table row selects']!(page);
      await interactions['dialog opens']!(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      await interactions['menu opens and an item is chosen']!(page);
      await interactions['tabs switch']!(page);
      await interactions['text editor takes typing']!(page);
      await interactions['toast shows']!(page);
      await page.screenshot({ path: artifactPath('screens', `${slug(info)}.png`), fullPage: true });
      log.save(slug(info));
      expect(log.hydrationProblems()).toEqual([]);
    });
  });
}
