// Does hydration reuse the server-rendered DOM nodes, or replace them afterwards?
// Usage: node diagnostics/node-survival.mjs [baseURL] [path]
// Holds references to server-rendered nodes before any script runs, waits for the page
// hydration marker plus a settle delay, then reports which references are still connected.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:18110';
const path = process.argv[3] ?? '/gate';
const prefix = process.env.ARTIFACT_PREFIX ?? 'start';

const selectors = {
  button: '.muxui-button',
  menuTrigger: '.muxui-menu__trigger',
  selectTrigger: '.muxui-select__trigger',
  tabList: '.muxui-tabs__list',
  tab: '[role="tab"]',
  tabPanel: '[role="tabpanel"]',
  table: '.muxui-table',
  tableBody: '.muxui-table__body',
  tableRow: '.muxui-table__row',
  tableCell: '.muxui-table__cell',
  numberInput: '.muxui-number-field input',
  dateSegment: '.muxui-date-segment',
  virtualizer: '.muxui-virtualizer',
};

const browser = await chromium.launch();
const results = [];
for (const cpu of [1, 6]) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  // Runs at document start; grabs the streamed server nodes as soon as the parser creates them.
  await page.addInitScript((selectorMap) => {
    const held = {};
    const grab = () => {
      for (const [name, selector] of Object.entries(selectorMap)) held[name] ??= document.querySelector(selector);
    };
    new MutationObserver(grab).observe(document, { childList: true, subtree: true });
    window.__serverNodes = held;
  }, selectors);
  await page.goto(path, { waitUntil: 'commit' });
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await page.waitForTimeout(1_000);
  const survived = await page.evaluate(() =>
    Object.fromEntries(Object.entries(window.__serverNodes).map(([name, node]) => [name, node ? node.isConnected : 'not found'])),
  );
  results.push({ path, cpu, survived });
  console.log(JSON.stringify({ path, cpu, survived }));
  await context.close();
}
await browser.close();
const out = join(import.meta.dirname, '..', 'artifacts', prefix, 'facts');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `node-survival-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.json`), JSON.stringify(results, null, 2));
