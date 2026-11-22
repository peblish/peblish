import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Shared by the composer specs: the seed (e2e/composer/seed.ts) and signed-in pages. The specs
// need the lane database for the seed, so against a remote BASE_URL they skip.

const root = join(import.meta.dirname, '../..');

export type Seed = {
  password: string;
  people: { poster: string; unverified: string; moderator: string; banned: string; young: string };
  communities: Record<
    'open' | 'staff' | 'closed' | 'remote' | 'adult' | 'gated' | 'gone' | 'remoteStaff' | 'long' | 'farAway' | 'named',
    { id: string; handle: string }
  >;
};

export const seed = (): Seed => JSON.parse(execFileSync('node', ['e2e/composer/seed.ts'], { cwd: root, encoding: 'utf8' })) as Seed;

/** Flips the uploads.enabled switch on the lane database (and makes sure the bucket exists). */
export const setUploads = (on: boolean) => execFileSync('node', ['e2e/composer/seed.ts', 'uploads', on ? 'on' : 'off'], { cwd: root });

/** A signed-in browser context for `name`, from one sign-in (the session is kept as storage state). */
export async function signedIn(browser: Browser, baseURL: string, name: string, password: string): Promise<BrowserContext> {
  const first = await browser.newContext({ baseURL });
  const page = await first.newPage();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, password);
  await landed(page, '/');
  const state = await first.storageState();
  await first.close();
  return browser.newContext({ baseURL, storageState: state });
}

/** The same session in a fresh context with an empty cache, for what must be measured cold. */
export const coldContext = async (browser: Browser, baseURL: string, context: BrowserContext) =>
  browser.newContext({ baseURL, storageState: await context.storageState() });

/** The page a locator is on, or the page itself. */
const pageOf = (within: Page | Locator): Page => ('page' in within && typeof within.page === 'function' ? within.page() : (within as Page));

/** `text` as a pattern that matches it literally. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Create post's community field (Mux ComboBox), on the page or inside the sheet. */
export const communityField = (within: Pick<Locator, 'getByRole'>) => within.getByRole('combobox', { name: 'Community' });

/** Opens the field's list (it opens on focus, and with the arrows when focused already), which shows every community when nothing is typed. */
export async function openCommunities(within: Page | Locator) {
  const field = communityField(within);
  await field.click();
  if ((await field.getAttribute('aria-expanded')) !== 'true') await field.press('ArrowDown');
  await expect(field).toHaveAttribute('aria-expanded', 'true');
}

/** A community's row in the field's open list: a popover on the page, outside the sheet when the field is in it. */
export const community = (within: Page | Locator, handle: string) =>
  pageOf(within)
    .getByRole('listbox')
    .getByRole('option', { name: new RegExp(`^!${literally(handle)}(,| |$)`) });

/** The community's radio in the list a browser without scripts gets. */
export const communityRadio = (within: Pick<Locator, 'getByRole'>, handle: string) =>
  within.getByRole('radio', { name: new RegExp(`^!${literally(handle)}`) });

/** The label around a radio. Mux UI draws its own radio and hides the native one, so a click goes to the label, as a person's does. */
export const radioLabel = (radio: Locator) => radio.locator('xpath=ancestor::label[1]');

/** Clicks the radio's label and checks the radio took the choice (what `check()` would have verified). */
async function pick(radio: Locator) {
  await radioLabel(radio).click();
  await expect(radio).toBeChecked();
}

/**
 * Chooses the community: types its handle into the field and takes its row, as a person does; without scripts
 * (the field hidden) clicks its radio.
 */
export async function choose(within: Page | Locator, handle: string) {
  const field = communityField(within);
  const radio = communityRadio(within, handle);
  // The sheet loads its form after it opens: wait for whichever control this browser shows (Mux hides the native
  // radio and draws its own in the label).
  await expect(field.or(radioLabel(radio)).filter({ visible: true })).toHaveCount(1);
  if (!(await field.isVisible())) return pick(radio);
  await field.fill(handle);
  await community(within, handle).click();
  await expect(field).toHaveValue(`!${handle}`);
}

/** Chooses a post type (Text, Link, Image) by its label. */
export const chooseType = (within: Pick<Locator, 'getByRole'>, name: string) => pick(within.getByRole('radio', { name, exact: true }));
