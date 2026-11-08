import { expect, test } from 'vitest';
import { negotiateLocale } from './negotiate.ts';

test.each([
  [undefined, 'en-US'],
  ['', 'en-US'],
  ['de-DE', 'de-DE'],
  ['de-de,de;q=0.9', 'de-DE'],
  ['de-AT', 'de-DE'],
  ['en-GB', 'en-US'],
  ['zz-ZZ', 'en-US'],
  ['zz-ZZ, de;q=0.5', 'de-DE'],
  ['fr-FR, de;q=0.8, en;q=0.9', 'en-US'],
  ['en;q=0.5, de;q=0.9', 'de-DE'],
  ['de;q=0, en;q=0.1', 'en-US'],
  ['de;q=0', 'en-US'],
  ['*', 'en-US'],
  ['fr, *;q=0.5, de;q=0.4', 'en-US'],
  ['not a tag!!, de', 'de-DE'],
])('Accept-Language %j negotiates %s', (header, locale) => {
  expect(negotiateLocale(header)).toBe(locale);
});
