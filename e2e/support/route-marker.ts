import type { Page } from '@playwright/test';

// The hydration-marker convention (frozen G0 contract 8). Route content sets
// html[data-hydrated] (packages/web/src/shell/hydration.ts); the root shell only sets
// html[data-shell-hydrated], which fires before route content is interactive.

// React 19 production builds report hydration failures as minified errors 418 (mismatch),
// 419, 421, 422, 423 and 425; development builds spell them out.
const HYDRATION_PATTERNS = [
  /hydrat/i,
  /did not match/i,
  /switch(?:ed)? to client rendering/i,
  /react\.dev\/errors\/(418|419|421|422|423|425)\b/,
  /Minified React error #(418|419|421|422|423|425)\b/,
];

export type LoggedMessage = { type: string; text: string };

/** Collects console messages and page errors from the moment it is attached. */
export function recordConsole(page: Page) {
  const messages: LoggedMessage[] = [];
  page.on('console', (message) => messages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => messages.push({ type: 'pageerror', text: `${error.name}: ${error.message}` }));
  const problems = () => messages.filter(({ type }) => type === 'error' || type === 'warning' || type === 'pageerror');
  return {
    messages,
    problems,
    hydrationProblems: () => problems().filter(({ text }) => HYDRATION_PATTERNS.some((pattern) => pattern.test(text))),
  };
}

/**
 * Navigates without waiting for the load event and resolves as soon as the route-content
 * marker appears, so the caller's next action is the first one after hydration.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'commit' });
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
}
