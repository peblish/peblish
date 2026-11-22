import { expect, test } from 'vitest';
import { brandLinks, brandMeta } from './brand-head.ts';

test('no pack adds nothing to the head', () => {
  expect(brandLinks('')).toEqual([]);
  expect(brandMeta('', 'system')).toEqual([]);
});

test("a pack links its sheet and icons, and gives the scheme's theme colour or both by media query", () => {
  const links = brandLinks('feddit');
  expect(links.map(({ rel }) => rel)).toEqual(['stylesheet', 'icon', 'icon', 'apple-touch-icon']);
  // The files' addresses are Vite's to give (e2e/shell/brand.serial.spec.ts loads them).
  expect(links[0]).toMatchObject({ id: 'pb-brand-css' });
  expect(brandMeta('feddit', 'light')).toEqual([{ name: 'theme-color', content: '#f1f4f6' }]);
  expect(brandMeta('feddit', 'black')).toEqual([{ name: 'theme-color', content: '#242a2f' }]);
  expect(brandMeta('feddit', 'system').map(({ media }) => media)).toEqual([
    '(prefers-color-scheme: light)',
    '(prefers-color-scheme: dark)',
  ]);
});
