import { expect, test } from 'vitest';
import { BannerPublish, defaultBanner, InternalPath, SiteBanner } from './banner.ts';

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
