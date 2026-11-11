import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// Helpers for the lane A flows: the seeded admin, TOTP codes, mail from Mailpit (compose:
// HTTP API on 18426, shared by every lane, so each run uses its own addresses).

const root = join(import.meta.dirname, '../..');
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:18426';

export type Admin = { name: string; email: string; password: string; totpSecret: string; backupCodes: string[] };

/** packages/core/src/testing/seed-a.ts against the lane database (DATABASE_URL from lane.sh). */
export function seed(...args: string[]): unknown {
  return JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-a.ts', ...args], { cwd: root, encoding: 'utf8' }));
}

/** A name nobody used in an earlier run: the lane database keeps its accounts. */
export const unique = (prefix: string) => `${prefix}_${randomBytes(3).toString('hex')}`;

/** RFC 6238, six digits, 30 seconds; the key is the secret's raw bytes. */
export function totp(secret: Uint8Array | string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 15;
  return String(mac.readUInt32BE(offset) & 0x7fffffff)
    .slice(-6)
    .padStart(6, '0');
}

const usedSteps = new Map<string, number>();

/**
 * A TOTP code the server has not accepted yet. It takes each 30-second step once
 * (core/identity/totp-replay.ts) and the next step early, so a second code within one step is
 * the next step's, and a third waits for the clock.
 */
export async function freshTotp(secret: Uint8Array | string): Promise<string> {
  const key = typeof secret === 'string' ? secret : Buffer.from(secret).toString('hex');
  const now = Math.floor(Date.now() / 30_000);
  const step = Math.max(now, (usedSteps.get(key) ?? now - 1) + 1);
  if (step > now + 1) await new Promise((resolve) => setTimeout(resolve, (step - 1) * 30_000 - Date.now() + 100));
  usedSteps.set(key, step);
  return totp(secret, step * 30_000);
}

/** The authenticator key the security page shows (base32, in groups of four) as bytes. */
export function base32(key: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of key.replace(/\s/g, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Uint8Array.from(bits.match(/.{8}/g) ?? [], (byte) => parseInt(byte, 2));
}

/** The first link in the newest mail to `to`, moved onto the server under test. */
export async function mailedLink(to: string, baseURL: string, after = 0): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const { messages } = (await search.json()) as { messages: { ID: string }[] };
        if (messages.length <= after) return false;
        const message = await fetch(`${mailpit}/api/v1/message/${messages[0]?.ID}`);
        text = ((await message.json()) as { Text: string }).Text;
        return true;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const link = new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? '');
  return new URL(link.pathname + link.search, baseURL).href;
}

/** How many mails `to` has had. */
export async function mailCount(to: string): Promise<number> {
  const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return ((await search.json()) as { messages: unknown[] }).messages.length;
}

/** Waits until the page that a form navigated to has hydrated. */
export async function landed(page: Page, path: string | RegExp): Promise<void> {
  await page.waitForURL(path);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
}

export async function signIn(page: Page, identifier: string, password: string): Promise<void> {
  await page.getByLabel('Email or handle').fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function signOut(page: Page): Promise<void> {
  await page.goto('/settings/account');
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('/');
}

/** How long `expectAccessible` waits for running animations and transitions to end. */
const settleTimeout = 3_000;

/**
 * Waits until no animation or transition that will end is running (a paused one, or one at a
 * playback rate of zero or with endless iterations, never ends, so it is measured as it stands), reading
 * the list again after a frame so one that starts during the wait is waited for too. Fails after
 * `settleTimeout`, naming each element on the last list read, also when that frame never comes.
 */
async function settleAnimations(page: Page): Promise<void> {
  const unsettled = await page.evaluate(async (timeout) => {
    const ending = () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            animation.playbackRate !== 0 &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity),
        );
    const describe = (animation: Animation) => {
      const effect = animation.effect;
      const target = effect instanceof KeyframeEffect ? effect.target : null;
      const element = target
        ? `${target.localName}${target.id ? `#${target.id}` : ''}${[...target.classList].map((name) => `.${name}`).join('')}${effect instanceof KeyframeEffect && effect.pseudoElement ? effect.pseudoElement : ''}`
        : 'an element-less animation';
      const what =
        animation instanceof CSSTransition
          ? `transition of ${animation.transitionProperty}`
          : animation instanceof CSSAnimation
            ? `animation ${animation.animationName}`
            : 'script animation';
      return `${element} (${what})`;
    };
    // The last list read. Every wait below, the frame too (a background page may never paint one),
    // races the one deadline; when it wins, this list is what was still animating.
    let running: Animation[] = [];
    let late = false;
    const rounds = async () => {
      for (;;) {
        running = ending();
        if (running.length === 0 || late) return;
        await Promise.allSettled(running.map((animation) => animation.finished));
        // A frame for styles to update, so an animation started by one that just ended is on the list.
        await new Promise(requestAnimationFrame);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        resolve();
      }, timeout);
    });
    await Promise.race([rounds(), deadline]);
    clearTimeout(timer);
    return late ? running.map(describe) : [];
  }, settleTimeout);
  expect(unsettled, `still animating after ${settleTimeout} ms, so axe would measure a page in motion`).toEqual([]);
}

/**
 * WCAG 2.2 AA and best practice, as the shell's a11y spec runs it, on every rule and element.
 * Measured once every animation and transition that will end has ended: a panel that is still
 * fading in (Mux's Disclosure) would read as low contrast.
 */
export async function expectAccessible(page: Page): Promise<void> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target.join(' ')) }))).toEqual([]);
}
