import { expect, test, type Browser } from '@playwright/test';
import { galleryStates, stateProblems } from '../support/states.ts';

// The shared state helper (e2e/support/states.ts) on two fixture pages served from the browser, each a field
// with no focus ring: one whose edge focus leaves as it was, which has no focus indicator and must be failed,
// and one whose edge focus recolours, which must pass. Their page has the gallery's state markup.

const page = (focusEdge: string) => `<!doctype html>
<html lang="en" data-hydrated="1"><head><meta charset="utf-8"><title>Fixture</title>
<style>
  body { background: #fff; color: #111; margin: 2rem; }
  input { border: 2px solid #333; outline: none; background: #fff; color: #111; font-size: 1rem; min-height: 44px; min-width: 44px; }
  input:focus { border-color: ${focusEdge}; }
</style></head>
<body><main><section data-kit-state="rest" aria-label="rest"><div data-kit-sample>
  <label>Name <input name="name"></label>
</div></section></main></body></html>`;

/** `browser`, with every new context serving `path` as `html` instead of asking the server. */
const serving = (browser: Browser, path: string, html: string): Pick<Browser, 'newContext'> => ({
  newContext: async (options) => {
    const context = await browser.newContext(options);
    await context.route(`**${path}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    return context;
  },
});

const focusProblems = async (browser: Browser, baseURL: string, focusEdge: string) => {
  const path = '/state-helper-fixture';
  const checks = await galleryStates(serving(browser, path, page(focusEdge)), baseURL, path);
  return stateProblems(checks).filter((problem) => problem.includes('focus ring'));
};

test('a field whose edge focus leaves as it was has no focus indicator', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const problems = await focusProblems(browser, baseURL!, '#333');
  // Every scheme and condition but forced colours, where the browser draws the edge (and Highlight) itself.
  expect(problems).toEqual(expect.arrayContaining(['light default focus: focus ring missing', 'dark default focus: focus ring missing']));
});

test('a field whose edge focus recolours passes on its edge', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(await focusProblems(browser, baseURL!, '#0047b3')).toEqual([]);
});
