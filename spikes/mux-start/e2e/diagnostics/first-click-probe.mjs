// Repeated first-click probe for collection components after hydration.
// Usage: node diagnostics/first-click-probe.mjs [baseURL] [runs]
// Env: PATHS (comma list), DELAYS (ms, comma list), MARKER=shell|page (which hydration marker to wait for).
// For each target, CPU rate and delay it loads a fresh page, waits for the chosen hydration
// marker (plus the delay), clicks once, and checks the state; on a miss it clicks again.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:18110';
const runs = Number(process.argv[3] ?? 10);
const prefix = process.env.ARTIFACT_PREFIX ?? 'start';
const delays = (process.env.DELAYS ?? '0,250,1000').split(',').map(Number);
// shell: <html data-shell-hydrated> from the root route's effect; page: <html data-hydrated> from the gate content.
const markerName = process.env.MARKER === 'page' ? 'page' : 'shell';
const marker = markerName === 'page' ? 'html[data-hydrated="1"]' : 'html[data-shell-hydrated="1"]';

const targets = {
  tab: {
    click: (page) => page.getByRole('tab', { name: 'New' }).click(),
    done: (page) => page.getByRole('tab', { name: 'New' }).getAttribute('aria-selected').then((value) => value === 'true'),
  },
  tableRow: {
    click: (page) => page.locator('.muxui-table__row').nth(2).locator('.muxui-table__cell').first().click(),
    done: (page) => page.locator('.muxui-table__row').nth(2).getAttribute('data-muxui-state-selected').then((value) => value !== null),
  },
  menu: {
    click: (page) => page.getByRole('button', { name: 'Post actions' }).click(),
    done: (page) => page.getByRole('menu').isVisible(),
  },
  select: {
    click: (page) => page.locator('.muxui-select__trigger').click(),
    done: (page) => page.getByRole('listbox', { name: /Community/ }).isVisible(),
  },
};

async function settle(page, done, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done(page)) return true;
    await page.waitForTimeout(50);
  }
  return done(page);
}

const browser = await chromium.launch();
const rows = [];
for (const path of (process.env.PATHS ?? '/gate,/gate-plain').split(',')) {
  for (const cpu of [1, 4, 6]) {
    for (const delay of delays) {
      for (const [name, target] of Object.entries(targets)) {
        let firstMiss = 0;
        let secondMiss = 0;
        const commits = [];
        for (let run = 0; run < runs; run += 1) {
          const context = await browser.newContext({ baseURL });
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
          await page.goto(path, { waitUntil: 'commit' });
          await page.locator(marker).waitFor({ state: 'attached' });
          if (delay) await page.waitForTimeout(delay);
          const atMarker = await page.evaluate(() => document.documentElement.dataset.gateCommits ?? null);
          await target.click(page);
          if (!(await settle(page, target.done, 1500))) {
            firstMiss += 1;
            await target.click(page);
            if (!(await settle(page, target.done, 1500))) secondMiss += 1;
          }
          commits.push(atMarker);
          await context.close();
        }
        const row = { path, marker: markerName, cpu, delayMs: delay, target: name, runs, firstClickMissed: firstMiss, secondClickAlsoMissed: secondMiss, gateCommitsBeforeClick: commits };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
}
await browser.close();
const out = join(import.meta.dirname, '..', 'artifacts', prefix, 'facts');
mkdirSync(out, { recursive: true });
const label = `${markerName}-marker-${process.env.PATHS ?? 'all'}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
writeFileSync(join(out, `first-click-probe-${label}.json`), JSON.stringify(rows, null, 2));
