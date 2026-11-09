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
  // An explicit exclusion beats a less specific range that would allow the locale.
  ['de-DE;q=0,de;q=1,en-US;q=0.5', 'en-US'],
  ['de-AT;q=1, de-DE;q=0', 'en-US'],
  ['*;q=0.5, de-DE;q=0', 'en-US'],
  ['en-US;q=0, de', 'de-DE'],
  ['en-US;q=0, *', 'de-DE'],
  // The q parameter is case-insensitive.
  ['de;Q=0.9, en;q=0.1', 'de-DE'],
  ['en;Q=0, de;q=0.1', 'de-DE'],
  ['de;q=nope, en', 'en-US'],
  ['de, en', 'de-DE'],
])('Accept-Language %j negotiates %s', (header, locale) => {
  expect(negotiateLocale(header)).toBe(locale);
});
