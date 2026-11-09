import { proxyUrlBuilder } from '@peblish/core/media/proxy-url';
import type { PostPage } from '@peblish/core/posts/read';
import { describe, expect, test } from 'vitest';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { postMedia, postTime, threadVisible } from './-page-data.ts';

const site = { origin: 'https://feddit.example', remoteMedia: true, proxy: proxyUrlBuilder(Buffer.alloc(32, 7)) };
const proxied = /^\/media\/proxy\/[\w-]+\/[\w-]+$/;

const view = (extra: Partial<Parameters<typeof postMedia>[0]> = {}) => ({ url: null, urlContentType: null, thumbnailUrl: null, ...extra });

describe('the post page media', () => {
  test('a thumbnail is this instance’s own media as a root-relative path, or a signed proxy path', async () => {
    const renderer = await createMarkdownRenderer(site);
    const thumbnail = (url: string) => postMedia(view({ thumbnailUrl: url }), renderer).thumbnail;
    expect(thumbnail('https://feddit.example/media/a.png')).toBe('/media/a.png');
    expect(thumbnail('/media/a.png')).toBe('/media/a.png');
    expect(thumbnail('https://img.example/a.png')).toMatch(proxied);
    // Not this instance's path: a protocol-relative URL and a script URL never load.
    expect(thumbnail('//img.example/a.png')).toBeNull();
    expect(thumbnail('javascript:alert(1)')).toBeNull();
  });

  test('a remote URL too long to proxy shows as a link instead of failing the page', async () => {
    const renderer = await createMarkdownRenderer(site);
    const long = `https://img.example/${'x'.repeat(3_000)}`;
    expect(postMedia(view({ thumbnailUrl: long, url: long, urlContentType: 'image/png' }), renderer)).toEqual({
      thumbnail: null,
      image: null,
    });
  });

  test('remote media off means no remote picture at all', async () => {
    const renderer = await createMarkdownRenderer({ ...site, remoteMedia: false });
    const media = postMedia(
      view({ thumbnailUrl: 'https://img.example/t.png', url: 'https://img.example/a.png', urlContentType: 'image/png' }),
      renderer,
    );
    expect(media).toEqual({ thumbnail: null, image: null });
  });

  test('an image post is a link of an image type other than SVG, including the placeholder image/*', async () => {
    const renderer = await createMarkdownRenderer(site);
    const image = (urlContentType: string | null) => postMedia(view({ url: 'https://img.example/a', urlContentType }), renderer).image;
    expect(image('image/png')).toMatch(proxied);
    expect(image('IMAGE/WEBP')).toMatch(proxied);
    expect(image('image/*')).toMatch(proxied);
    expect(image('image/svg+xml')).toBeNull();
    expect(image('text/html')).toBeNull();
    expect(image(null)).toBeNull();
  });
});

describe('the thread of a post page', () => {
  const page = (extra: { gate?: PostPage['gate']; removed?: boolean; deleted?: boolean; moderator?: boolean }) => ({
    gate: extra.gate ?? 'none',
    moderator: extra.moderator ?? false,
    view: { removed: extra.removed ?? false, deleted: extra.deleted ?? false },
  });

  test('is sent with a visible post, a blurred one and a tombstone', () => {
    expect(threadVisible(page({}))).toBe(true);
    expect(threadVisible(page({ gate: 'blur' }))).toBe(true);
    expect(threadVisible(page({ deleted: true }))).toBe(true);
  });

  test('is withheld with the gated post', () => {
    expect(threadVisible(page({ gate: 'sign-in' }))).toBe(false);
    expect(threadVisible(page({ gate: 'age' }))).toBe(false);
    expect(threadVisible(page({ gate: 'age', moderator: true }))).toBe(false);
  });

  test('is withheld under a removed post, except from the moderators who still read that post', () => {
    expect(threadVisible(page({ removed: true }))).toBe(false);
    expect(threadVisible(page({ removed: true, moderator: false }))).toBe(false);
    expect(threadVisible(page({ removed: true, moderator: true }))).toBe(true);
  });
});

describe('the post time', () => {
  const iso = '2026-11-09T02:39:47.092Z';

  test('is the UTC date and time in the request’s locale, whatever the process time zone', () => {
    // \s also matches the narrow no-break space that newer ICU puts before AM.
    expect(postTime('en-US', iso)).toMatch(/^Nov 9, 2026, 2:39\sAM UTC$/);
    expect(postTime('de-DE', iso)).toBe('9. Nov. 2026, 02:39 UTC');
    expect(postTime('de-DE', '2026-11-09T23:59:00Z')).toBe('9. Nov. 2026, 23:59 UTC');
  });
});
