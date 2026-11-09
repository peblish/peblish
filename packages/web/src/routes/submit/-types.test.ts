import { expect, test } from 'vitest';
import { catalogues } from '../../registry/i18n.gen.ts';
import { asComposerError, composerErrors, errorMessageKey } from './-types.ts';

test('the composer catalogue has the same keys in en and de, and every error code has a message in both', () => {
  expect(Object.keys(catalogues.composer.de).sort()).toEqual(Object.keys(catalogues.composer.en).sort());
  for (const code of composerErrors) {
    const { area, key } = errorMessageKey(code);
    const catalogue: Record<string, Record<string, string>> = catalogues[area];
    for (const language of ['en', 'de']) expect(catalogue[language]?.[key], `${code} in ${language}`).toBeTruthy();
  }
});

test('a code from the URL is one the composer has a message for, or generic', () => {
  expect(asComposerError('community.banned')).toBe('community.banned');
  expect(asComposerError('rate.limited')).toBe('generic');
  expect(asComposerError('')).toBeUndefined();
  expect(asComposerError(undefined)).toBeUndefined();
});
