import type { Page, TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** /gate wraps the content in RAC's I18nProvider; /gate-plain is the same content without it. */
export const GATE_PATHS = ['/gate', '/gate-plain'] as const;

const ARTIFACTS = join(import.meta.dirname, '..', 'artifacts', process.env.ARTIFACT_PREFIX ?? 'start');

export function artifactPath(...parts: string[]): string {
  const path = join(ARTIFACTS, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function writeArtifact(name: string, value: unknown): void {
  writeFileSync(artifactPath(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function slug(info: TestInfo): string {
  return info.titlePath.slice(1).join(' ').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

// React 19 production builds report hydration failures as minified errors 418 (mismatch),
// 419, 421 (update before hydration finished, the RAC 7474 symptom), 422, 423 and 425;
// development builds spell them out.
const HYDRATION_PATTERNS = [
  /hydrat/i,
  /did not match/i,
  /switch(?:ed)? to client rendering/i,
  /react\.dev\/errors\/(418|419|421|422|423|425)\b/,
  /Minified React error #(418|419|421|422|423|425)\b/,
];

export type LoggedMessage = { type: string; text: string; location?: string };

/** Collects every console message and uncaught page error from the moment it is attached. */
export function recordConsole(page: Page) {
  const messages: LoggedMessage[] = [];
  page.on('console', (message) => {
    const { url, lineNumber } = message.location();
    messages.push({ type: message.type(), text: message.text(), location: url ? `${url}:${lineNumber}` : undefined });
  });
  page.on('pageerror', (error) => messages.push({ type: 'pageerror', text: `${error.name}: ${error.message}` }));
  const problems = () => messages.filter(({ type }) => type === 'error' || type === 'warning' || type === 'pageerror');
  return {
    messages,
    problems,
    hydrationProblems: () => problems().filter(({ text }) => HYDRATION_PATTERNS.some((pattern) => pattern.test(text))),
    save: (name: string) => writeArtifact(join('console', `${name}.json`), messages),
  };
}

/**
 * Navigates without waiting for the load event and returns as soon as the page hydration
 * marker appears (set by the gate content, not the root shell; see GateContent), so the
 * caller's next action is the first one after hydration.
 */
export async function gotoHydrated(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' });
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  return page.evaluate(() => ({
    shellHydrated: document.documentElement.dataset.shellHydrated === '1',
    gateCommits: document.documentElement.dataset.gateCommits ?? null,
    markerAtMs: Math.round(performance.now()),
    editorMounted: document.querySelector('.muxui-text-editor [contenteditable="true"]') !== null,
    virtualizerRows: document.querySelectorAll('.muxui-virtualizer [role="option"]').length,
  }));
}
