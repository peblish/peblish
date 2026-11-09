import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';

// Only a supported, negotiated locale reaches <html lang> and Intl; anything else renders
// en-US, and the page says it varies by Accept-Language. The gallery prints a number so the
// formatting shows.
test.beforeEach(({ request }) => skipWithoutKit(request));

for (const [header, lang, sample] of [
  ['zz-ZZ', 'en-US', '1,234.5'],
  ['de-AT, en;q=0.5', 'de-DE', '1.234,5'],
  ['de;q=0, en-GB;q=0.1', 'en-US', '1,234.5'],
] as const) {
  test(`Accept-Language ${header} renders ${lang}`, async ({ request }) => {
    const response = await request.get('/kit', { headers: { 'accept-language': header } });
    const html = await response.text();
    expect(html).toMatch(new RegExp(`<html[^>]*\\slang="${lang}"`));
    expect(html).toContain(`data-testid="locale-sample">${sample}<`);
    expect(response.headers().vary).toContain('Accept-Language');
  });
}
