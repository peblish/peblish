import { expect, test, type Browser, type Page } from '@playwright/test';
import { colours } from '../support/contrast.ts';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';
import { seed, signIn, unique } from './support.ts';

// The account pages in the Commons frame (auth, invite, settings, blocks, Create post's layout): their
// compositions through the shared state helper, the phone's 44px targets on the pages themselves, a
// server refusal tied to its field as well as summarised, and Create post's rules in the rail or under
// the picker. Works with whatever brand pack site.brand names.

type Person = { name: string; password: string };

const compositions: Record<string, string[]> = {
  'auth-field': ['rest', 'disabled', 'invalid', 'hover', 'focus', 'pressed'],
  'form-actions': ['rest', 'disabled', 'pending', 'hover', 'focus', 'pressed'],
  'settings-tabs': ['rest', 'selected', 'hover', 'focus', 'pressed'],
  'community-rules': ['rest', 'pending', 'hover', 'focus', 'pressed'],
};

test.describe('gallery', () => {
  test.beforeEach(async ({ request }) => skipWithoutKit(request));
  test.setTimeout(360_000);
  for (const [composition, states] of Object.entries(compositions)) {
    // A text link inside a line of text (Sign up with an invite, the summary's link to the field, the rules'
    // link) is held to WCAG's 24px; the controls themselves are held to 44 below.
    test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
      const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
      expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
      expect(checks).toHaveLength(states.length * 2 * 4);
      // Mux's text field shows keyboard focus as its edge's colour, which the helper measures for a field.
      expect(stateProblems(checks, { target: 24 })).toEqual([]);
    });
  }
});

/** The smallest side of each visible control `selector` finds, rounded, under 44px. */
const under44 = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes
      .filter((node) => node.checkVisibility())
      .map((node) => {
        const { width, height } = node.getBoundingClientRect();
        return `${node.textContent?.trim() || node.getAttribute('name') || node.tagName}: ${Math.round(Math.min(width, height))}`;
      })
      .filter((entry) => Number(entry.split(': ').pop()) < 44),
  );

async function phone(page: Page, baseURL: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{ ...prefsCookie('card', 'light'), url: baseURL }]);
}

/** Signs in a new person, or `who` again (a second session), on a page of its own. */
async function signedIn(browser: Browser, baseURL: string, who?: Person): Promise<{ page: Page; person: Person }> {
  const person = who ?? (seed('e2e-person', unique('commons')) as Person);
  const page = await browser.newPage({ baseURL });
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, person.name, person.password);
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'));
  return { page, person };
}

test('on a phone the sign-in, sign-up and reset forms have 44px fields and buttons', async ({ page, baseURL }) => {
  await phone(page, baseURL!);
  for (const path of ['/auth/sign-in', '/auth/sign-up', '/auth/reset', '/auth/two-factor']) {
    await gotoHydrated(page, path);
    const form = 'main form';
    expect(await under44(page, `${form} button, ${form} input:not([type="hidden"]):not([type="checkbox"]), ${form} select`), path).toEqual(
      [],
    );
  }
});

test('on a phone the settings tabs, the forms, their rows and Create post have 44px controls', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const { page, person } = await signedIn(browser, baseURL!);
  // A second session, so Security lists one to revoke; a second person, so Blocks has a row and an Undo.
  const other = seed('e2e-person', unique('blocked')) as Person;
  await phone(page, baseURL!);
  await gotoHydrated(page, '/settings/blocks');
  await page.getByLabel('Block a person by handle').fill(`@${other.name}`);
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(page).toHaveURL(/just=/);
  await expect(page.getByRole('status')).toBeVisible();
  const rows = 'main nav a, main form button, main form input:not([type="hidden"])';
  expect(await under44(page, rows), '/settings/blocks').toEqual([]);
  expect(await page.locator('main form button').count()).toBeGreaterThanOrEqual(3);
  const { page: elsewhere } = await signedIn(browser, baseURL!, person);
  for (const path of ['/settings/account', '/settings/security']) {
    await gotoHydrated(page, path);
    expect(await under44(page, rows), path).toEqual([]);
  }
  await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible();
  await gotoHydrated(page, '/submit');
  // Create post's own controls: the title field and the form's buttons (the editor's toolbar is the composer's).
  expect(await under44(page, 'main input[name="title"], main .cmp__actions button')).toEqual([]);
  await elsewhere.close();
  await page.close();
});

test('a focused field draws its edge at 3:1 against the page, in light and dark', async ({ browser, baseURL }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ baseURL, colorScheme: scheme });
    await gotoHydrated(page, '/auth/sign-in');
    await page.keyboard.press('Tab');
    const input = page.getByLabel('Email or handle');
    await input.focus();
    await expect(input).toHaveAttribute('data-muxui-state-focus-visible');
    // Mux's field draws keyboard focus as its edge's colour (an outline inside the box), not a ring outside it.
    // Polled: Mux eases the edge's colour in over 350ms.
    await expect.poll(async () => (await colours(input)).border?.ratio ?? 0, { message: scheme }).toBeGreaterThanOrEqual(3);
    await page.close();
  }
});

for (const javaScriptEnabled of [true, false]) {
  test(`a server refusal is summarised and tied to its field, with scripts ${javaScriptEnabled ? 'on' : 'off'}`, async ({
    browser,
    baseURL,
  }) => {
    const page = await browser.newPage({ baseURL, javaScriptEnabled });
    const path = '/auth/reset?token=commons-sample&error=password.too_short';
    if (javaScriptEnabled) await gotoHydrated(page, path);
    else await page.goto(path);
    const form = page.getByRole('form', { name: 'Choose a new password' });
    const alert = form.getByRole('alert');
    // The summary is the form's one alert; it links to the field, which says it again as its description.
    await expect(form.getByRole('alert')).toHaveCount(1);
    await expect(alert).toHaveText('Use at least 12 characters.');
    const input = form.getByLabel('New password');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(/Use at least 12 characters\./);
    expect(await alert.getByRole('link').getAttribute('href')).toBe(`#${await input.getAttribute('id')}`);
    await alert.getByRole('link').click();
    await expect(input).toBeFocused();
    if (javaScriptEnabled) {
      // Typed in, the field drops the refusal; the summary stays until the next answer.
      await input.fill('a long enough passphrase');
      await expect(input).not.toHaveAttribute('aria-invalid', 'true');
      await expect(input).not.toHaveAccessibleDescription(/Use at least 12 characters\./);
      await expect(alert).toBeVisible();
    }
    await page.close();
  });
}

test('a refusal that names no field stays the form’s alone', async ({ page }) => {
  await gotoHydrated(page, '/auth/sign-in?error=credentials.invalid');
  const form = page.getByRole('form', { name: 'Sign in' });
  await expect(form.getByRole('alert')).toHaveText('Email or password is wrong.');
  await expect(form.getByRole('alert').getByRole('link')).toHaveCount(0);
  await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
});

test('the page’s name is its one h1, in the page', async ({ page }) => {
  for (const [path, name] of [
    ['/auth/sign-in', 'Sign in'],
    ['/auth/reset', 'Reset your password'],
  ] as const) {
    await gotoHydrated(page, path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(name);
  }
});

test('Create post shows the rules in the rail beside the form, and under the picker where the rail gives way', async ({
  browser,
  baseURL,
}) => {
  const { page } = await signedIn(browser, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/submit');
  const rules = page.getByRole('complementary', { name: 'Community rules' });
  // One copy in view at a time: the rail's beside the main column, then the one inside the form.
  await expect(rules).toHaveCount(1);
  await expect(rules).toHaveClass(/pb-rail/);
  await expect(rules).toContainText('Choose a community');
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rules).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('complementary', { name: 'Community rules' })).toBeVisible();
  await page.close();
});
