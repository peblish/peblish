import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// The auth fields (auth/-ui/form.tsx Field): what the browser checks before a post, how a field
// explains itself once React Aria has taken over the browser's own bubble, and the native
// attributes password managers and phones read. Sign-up opens without an invite code: every page
// view that looks one up counts against the address's budget for unknown codes.

const messages = {
  'en-US': {
    required: 'Fill in this field.',
    email: 'Enter an email address, like name@example.com.',
    short: 'Use at least 12 characters.',
  },
  'de-DE': {
    required: 'Fülle dieses Feld aus.',
    email: 'Gib eine E-Mail-Adresse ein, etwa name@example.com.',
    short: 'Verwende mindestens 12 Zeichen.',
  },
};

const field = (page: Page, name: string) => page.locator(`form input[name="${name}"]`);

/** Counts the form posts a page sends, so a test can show the browser stopped one. */
function posts(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') count++;
  });
  return () => count;
}

/** The field shows `message` as an alert that is also its accessible description, and the browser's focus is on it. */
async function expectExplained(page: Page, name: string, message: string): Promise<void> {
  const input = field(page, name);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page
      .locator('.auth-field')
      .filter({ has: page.locator(`input[name="${name}"]`) })
      .getByRole('alert'),
  ).toHaveText(message);
  await expect(input).toHaveAccessibleDescription(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

/** Everything on sign-up filled and valid, so the one field a test breaks is the only invalid one. */
async function fillSignUp(page: Page): Promise<void> {
  await field(page, 'invite').fill('PB-2222-2222');
  await field(page, 'username').fill('someone');
  await field(page, 'email').fill('someone@example.test');
  await field(page, 'password').fill('a long enough passphrase');
  await field(page, 'day').fill('14');
  await page.locator('form select[name="month"]').selectOption('3');
  await field(page, 'year').fill('1994');
  const terms = page.locator('form input[name="terms"]');
  await terms.focus();
  await page.keyboard.press('Space');
  await expect(terms).toBeChecked();
}

for (const locale of ['en-US', 'de-DE'] as const) {
  test.describe(locale, () => {
    test.use({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });
    const text = messages[locale];

    test('sign-in explains an empty field in the page language, then clears it', async ({ page }) => {
      const log = recordConsole(page);
      const sent = posts(page);
      await gotoHydrated(page, '/auth/sign-in');
      await page.locator('form button[type="submit"]').click();
      await expectExplained(page, 'identifier', text.required);
      await expect(page.getByRole('alert')).toHaveCount(2);
      await field(page, 'identifier').fill('nobody@example.test');
      await field(page, 'identifier').blur();
      await expect(page.getByRole('alert')).toHaveCount(1);
      await expect(field(page, 'identifier')).not.toHaveAttribute('aria-invalid', 'true');
      await page.locator('form button[type="submit"]').click();
      await expectExplained(page, 'password', text.required);
      expect(sent()).toBe(0);
      expect(log.problems()).toEqual([]);
    });

    test('sign-up explains an empty required field and a malformed email', async ({ page }) => {
      const sent = posts(page);
      await gotoHydrated(page, '/auth/sign-up');
      await fillSignUp(page);
      await field(page, 'username').fill('');
      await page.locator('form button[type="submit"]').click();
      await expectExplained(page, 'username', text.required);

      await field(page, 'username').fill('someone');
      await field(page, 'email').fill('not-an-email');
      await page.locator('form button[type="submit"]').click();
      await expectExplained(page, 'email', text.email);
      // The username was fixed, so its message went with the blur.
      await expect(page.getByRole('alert')).toHaveCount(1);

      await field(page, 'email').fill('someone@example.test');
      await field(page, 'password').fill('too short');
      await page.locator('form button[type="submit"]').click();
      await expectExplained(page, 'password', text.short);
      expect(sent()).toBe(0);
    });

    test('the reset request explains a malformed email', async ({ page }) => {
      await gotoHydrated(page, '/auth/reset');
      await field(page, 'email').fill('not-an-email');
      await page.locator('form button[type="submit"]').click();
      await expectExplained(page, 'email', text.email);
    });

    test('the date of birth shows the whole month name on a 320px phone, with no sideways scroll', async ({ page }) => {
      for (const width of [320, 375, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await gotoHydrated(page, '/auth/sign-up');
        const month = page.locator('form select[name="month"]');
        await month.selectOption('9');
        // A select never scrolls, so its scroll width says nothing: measure the chosen name against its text box.
        const fit = await month.evaluate((select: HTMLSelectElement) => {
          const style = getComputedStyle(select);
          const context = document.createElement('canvas').getContext('2d')!;
          context.font = style.font;
          const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return { room, needed: context.measureText(select.selectedOptions[0]?.text ?? '').width };
        });
        expect(fit.needed, `month at ${width}px`).toBeGreaterThan(0);
        expect(fit.needed, `month at ${width}px`).toBeLessThanOrEqual(fit.room);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(scroll, `sideways scroll at ${width}px`).toBe(0);
      }
    });
  });
}

test('the submitted inputs keep their native attributes', async ({ page }) => {
  type Expected = { name: string; type: string; autocomplete: string; inputmode?: string; maxlength?: string; minlength?: string };
  const pages: [string, Expected[]][] = [
    [
      '/auth/sign-in',
      [
        { name: 'identifier', type: 'text', autocomplete: 'username' },
        { name: 'password', type: 'password', autocomplete: 'current-password' },
      ],
    ],
    [
      '/auth/sign-up',
      [
        { name: 'invite', type: 'text', autocomplete: 'off' },
        { name: 'username', type: 'text', autocomplete: 'username' },
        { name: 'email', type: 'email', autocomplete: 'email' },
        { name: 'password', type: 'password', autocomplete: 'new-password', minlength: '12' },
        { name: 'day', type: 'text', autocomplete: '', inputmode: 'numeric', maxlength: '2' },
        { name: 'year', type: 'text', autocomplete: '', inputmode: 'numeric', maxlength: '4' },
      ],
    ],
    ['/auth/two-factor', [{ name: 'code', type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6' }]],
    ['/auth/two-factor?recovery=yes', [{ name: 'code', type: 'text', autocomplete: 'off' }]],
    ['/auth/reset', [{ name: 'email', type: 'email', autocomplete: 'email' }]],
    ['/auth/reset?token=x', [{ name: 'password', type: 'password', autocomplete: 'new-password', minlength: '12' }]],
  ];
  for (const [path, expected] of pages) {
    await gotoHydrated(page, path);
    const inputs = await page.locator('form input:not([type="hidden"], [type="checkbox"])').evaluateAll((elements: HTMLInputElement[]) =>
      elements.map((input) => {
        const read = (name: string) => input.getAttribute(name) ?? undefined;
        return {
          name: input.name,
          type: input.type,
          autocomplete: read('autocomplete') ?? '',
          inputmode: read('inputmode'),
          maxlength: read('maxlength'),
          minlength: read('minlength'),
        };
      }),
    );
    expect(inputs, path).toEqual(expected.map((input) => ({ inputmode: undefined, maxlength: undefined, minlength: undefined, ...input })));
  }
});

test('a link in the terms label navigates without ticking the box', async ({ page }) => {
  await gotoHydrated(page, '/auth/sign-up');
  const terms = page.getByRole('checkbox', { name: /^I agree to the Terms/ });
  await expect(terms).not.toBeChecked();
  // The client-side navigation keeps the document, so the box's state right after the click is kept on window.
  await page.evaluate(() => {
    document.addEventListener('click', () => {
      setTimeout(() => {
        const box = document.querySelector<HTMLInputElement>('form input[name="terms"]');
        Object.assign(window, { termsAfterClick: box?.checked });
      });
    });
  });
  await page.locator('form').getByRole('link', { name: 'Terms', exact: true }).click();
  await page.waitForURL('/terms');
  expect(await page.evaluate(() => (window as unknown as { termsAfterClick?: boolean }).termsAfterClick)).toBe(false);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the browser still stops an empty or malformed field before the post', async ({ page }) => {
    const sent = posts(page);
    await page.goto('/auth/sign-in');
    await page.locator('form button[type="submit"]').click();
    await expect(field(page, 'identifier')).toBeFocused();
    expect(await field(page, 'identifier').evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await page.goto('/auth/reset');
    await field(page, 'email').fill('not-an-email');
    await page.locator('form button[type="submit"]').click();
    expect(await field(page, 'email').evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
    expect(sent()).toBe(0);
    // No app message: the browser's own bubble explains it.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
