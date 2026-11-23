import { expect, test } from 'vitest';
import { BannerPublish, customBannerContrast, customBannerMinimum, defaultBanner, InternalPath, SiteBanner } from './banner.ts';

test('a banner action goes to a path on this site only', () => {
  expect(['/', '/c/news', '/post/1?sort=new#c2'].map((path) => InternalPath.allows(path))).toEqual([true, true, true]);
  for (const outside of ['//evil.test', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)', 'c/news', '/a b', '']) {
    expect(InternalPath.allows(outside), outside).toBe(false);
  }
});

test('a banner has every field and nothing else; the colour is #RRGGBB', () => {
  expect(SiteBanner.allows({ ...defaultBanner, primary: { label: 'Read more', href: '/about' } })).toBe(true);
  expect(SiteBanner.allows({ ...defaultBanner, extra: true })).toBe(false);
  const { link: _link, ...missing } = defaultBanner;
  expect(SiteBanner.allows(missing)).toBe(false);
  expect(['#007BA7', '#007ba7', '007ba7', '#07a', 'blue'].map((colour) => SiteBanner.allows({ ...defaultBanner, colour }))).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
  expect(SiteBanner.allows({ ...defaultBanner, link: { label: '', href: '/about' } })).toBe(false);
});

test('what an admin publishes leaves the revision to the server', () => {
  const { revision: _revision, ...published } = defaultBanner;
  expect(BannerPublish.allows(published)).toBe(true);
  expect(BannerPublish.allows(defaultBanner)).toBe(false);
});

test('a path refuses control characters, raw and percent-encoded: C0, DEL and C1', () => {
  for (const code of [0x00, 0x01, 0x09, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
    expect(InternalPath.allows(`/rules${String.fromCharCode(code)}`), `raw ${code}`).toBe(false);
    const hex = code.toString(16).padStart(2, '0');
    expect(InternalPath.allows(`/rules%${hex}`), `%${hex}`).toBe(false);
    expect(InternalPath.allows(`/rules%${hex.toUpperCase()}`), `%${hex.toUpperCase()}`).toBe(false);
  }
  // C1 as UTF-8 percent escapes.
  for (const escape of ['%C2%80', '%c2%85', '%C2%9F']) expect(InternalPath.allows(`/rules${escape}`), escape).toBe(false);
  // A lone C1 byte after another escape, and an escape that is no UTF-8 at all.
  for (const path of ['/rules%41%85', '/rules%20%9f', '/rules%E2%80', '/rules%zz']) expect(InternalPath.allows(path), path).toBe(false);
  // Their neighbours stay allowed.
  for (const path of ['/rules%20', '/rules%7E', '/rules%C2%A0', '/rules%E2%80%93', '/über'])
    expect(InternalPath.allows(path), path).toBe(true);
});

test("a custom colour's contrast follows Mux's rule: white or black on the colour, whichever reads better", () => {
  expect(customBannerContrast('#000000')).toBeCloseTo(21, 1);
  expect(customBannerContrast('#FFFFFF')).toBeCloseTo(21, 1);
  // Mid grey, where white and black are closest: black, at 4.69.
  expect(customBannerContrast('#777777')).toBeCloseTo(4.69, 2);
  expect(customBannerContrast('red')).toBeNull();
  // No opaque colour falls under 4.5: the closest call, where white and black tie, is about 4.58.
  let lowest = 21;
  for (let r = 0; r < 256; r += 5)
    for (let g = 0; g < 256; g += 5)
      for (let b = 0; b < 256; b += 5) {
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        lowest = Math.min(lowest, customBannerContrast(hex)!);
      }
  expect(lowest).toBeGreaterThanOrEqual(customBannerMinimum);
  expect(lowest).toBeLessThan(4.6);
});
