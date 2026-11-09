import { expect, test } from 'vitest';
import { catalogues } from '../registry/i18n.gen.ts';
import { translatePlural } from './translate.ts';

// The two catalogues lane UI owns are complete in both languages, with every plural key's forms.
test.each(['shell', 'ui'] as const)('the %s catalogue has the same keys in en and de', (area) => {
  expect(Object.keys(catalogues[area].de).sort()).toEqual(Object.keys(catalogues[area].en).sort());
});

test('plural messages pick their form by the locale and format the count', () => {
  expect(translatePlural('en-US', 'ui', 'post.comments', 1)).toBe('1 comment');
  expect(translatePlural('en-US', 'ui', 'post.comments', 1234)).toBe('1,234 comments');
  expect(translatePlural('de-DE', 'ui', 'post.comments', 1)).toBe('1 Kommentar');
  expect(translatePlural('de-DE', 'ui', 'post.comments', 0)).toBe('0 Kommentare');
});
