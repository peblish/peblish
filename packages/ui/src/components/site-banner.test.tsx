import { bannerTones, defaultBanner } from '@peblish/schema/banner';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { muxTone, SiteBanner, type SiteBannerContent } from './site-banner.tsx';

const content: SiteBannerContent = { ...defaultBanner, message: 'Posting pauses tonight.' };
const draw = (banner: Partial<SiteBannerContent>) =>
  renderToStaticMarkup(<SiteBanner banner={{ ...content, ...banner }} label="Site notice" dismissLabel="Dismiss notice" />);

test('every tone of the setting draws, Accent as Mux brand and Custom as its colour', () => {
  for (const tone of bannerTones) expect(() => draw({ tone }), tone).not.toThrow();
  expect(muxTone({ tone: 'accent', colour: '#000000' })).toEqual({ tone: 'brand' });
  expect(muxTone({ tone: 'warning', colour: '#000000' })).toEqual({ tone: 'warning' });
  expect(draw({ tone: 'custom', colour: '#6e4bd8' })).toContain('data-muxui-tone="custom"');
  // Mux falls back to the tone given for a colour that is not opaque.
  expect(draw({ tone: 'custom', colour: 'rgba(110, 75, 216, 0.5)' })).toContain('data-muxui-tone="neutral"');
});

test('the text is plain: markup in the message or the title is shown as text', () => {
  const html = draw({ title: '<b>Hi</b>', message: '**bold** <img src=x onerror=alert(1)>' });
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<b>');
  expect(html).toContain('**bold** &lt;img');
});

test('a named region with its button, link and dismiss, each only when set', () => {
  const html = draw({
    primary: { label: 'Details', href: '/about' },
    link: { label: 'Rules', href: '/rules' },
    dismissible: true,
    icon: 'wrench',
  });
  expect(html).toContain('role="region"');
  expect(html).toContain('aria-label="Site notice"');
  // The button action is a real link drawn as Mux's banner button, so it works with scripts off too.
  expect(html).toMatch(
    /<a [^>]*class="[^"]*muxui-button[^"]*muxui-banner__action[^"]*"[^>]*href="\/about"|<a [^>]*href="\/about"[^>]*class="[^"]*muxui-button[^"]*muxui-banner__action/,
  );
  expect(html).not.toContain('<button class="muxui-button muxui-banner__action');
  expect(html).toMatch(/<a [^>]*href="\/rules"[^>]*>Rules<\/a>/);
  expect(html).toContain('aria-label="Dismiss notice"');
  expect(html).toContain('muxui-banner__icon');
  const bare = draw({ dismissible: false });
  expect(bare).not.toContain('<button');
  expect(bare).not.toContain('<a ');
  expect(bare).not.toContain('muxui-banner__icon');
});
