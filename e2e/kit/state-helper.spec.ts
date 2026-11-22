import { expect, test, type Browser } from '@playwright/test';
import { galleryStates, stateProblems } from '../support/states.ts';

// The shared state helper (e2e/support/states.ts) on fixture pages served from the browser: a field with no
// focus ring whose edge focus leaves as it was, and a button whose ring is the same focused and not, have no
// focus indicator and must be failed; a field whose edge focus recolours, and a button whose ring focus draws,
// must pass. Their page has the gallery's state markup.

const fixture = (css: string, control: string) => `<!doctype html>
<html lang="en" data-hydrated="1"><head><meta charset="utf-8"><title>Fixture</title>
<style>
  body { background: #fff; color: #111; margin: 2rem; }
  ${css}
</style></head>
<body><main><section data-kit-state="rest" aria-label="rest"><div data-kit-sample>
  ${control}
</div></section></main></body></html>`;

const page = (focusEdge: string) =>
  fixture(
    `input { border: 2px solid #333; outline: none; background: #fff; color: #111; font-size: 1rem; min-height: 44px; min-width: 44px; }
  input:focus { border-color: ${focusEdge}; }`,
    '<label>Name <input name="name"></label>',
  );

/** A button with `rest` as its outline, and `focused` once it has keyboard focus. */
const button = (rest: string, focused: string) =>
  fixture(
    `button { border: 0; background: #fff; color: #111; font-size: 1rem; min-height: 44px; min-width: 44px; outline: ${rest}; outline-offset: 2px; }
  button:focus-visible { outline: ${focused}; outline-offset: 2px; }`,
    '<button type="button">Save</button>',
  );

/** `browser`, with every new context serving `path` as `html` instead of asking the server. */
const serving = (browser: Browser, path: string, html: string): Pick<Browser, 'newContext'> => ({
  newContext: async (options) => {
    const context = await browser.newContext(options);
    await context.route(`**${path}`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    return context;
  },
});

const focusProblems = async (browser: Browser, baseURL: string, html: string) => {
  const path = '/state-helper-fixture';
  const checks = await galleryStates(serving(browser, path, html), baseURL, path);
  return stateProblems(checks).filter((problem) => problem.includes('focus ring'));
};

test('a field whose edge focus leaves as it was has no focus indicator', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const problems = await focusProblems(browser, baseURL!, page('#333'));
  // Every scheme and condition but forced colours, where the browser draws the edge (and Highlight) itself.
  expect(problems).toEqual(expect.arrayContaining(['light default focus: focus ring missing', 'dark default focus: focus ring missing']));
});

test('a field whose edge focus recolours passes on its edge', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(await focusProblems(browser, baseURL!, page('#0047b3'))).toEqual([]);
});

test('a button whose ring is the same focused and not has no focus indicator', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const problems = await focusProblems(browser, baseURL!, button('2px solid #0047b3', '2px solid #0047b3'));
  expect(problems).toEqual(expect.arrayContaining(['light default focus: focus ring missing', 'dark default focus: focus ring missing']));
});

test('a button whose ring focus draws passes on its ring', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(await focusProblems(browser, baseURL!, button('none', '2px solid #0047b3'))).toEqual([]);
});
