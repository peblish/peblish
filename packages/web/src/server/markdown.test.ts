import { expect, test } from 'vitest';
import { createMarkdownRenderer } from './markdown.ts';

const site = { origin: 'https://feddit.example', remoteMedia: true };
const images = '![own](https://feddit.example/media/a.png) ![remote](https://img.example/b.png)';

test('each body renders once per renderer, keyed by its content and options', async () => {
  const md = await createMarkdownRenderer(site);
  expect(md.render('**hi**')).toBe(md.render('**hi**'));
  expect(md.render('x[^1]\n\n[^1]: y', { idPrefix: 'a' })).not.toBe(md.render('x[^1]\n\n[^1]: y', { idPrefix: 'b' }));
  expect(md.sanitize('<p>hi</p>')).toBe(md.sanitize('<p>hi</p>'));
  expect((await createMarkdownRenderer(site)).render('**hi**')).not.toBe(md.render('**hi**'));
});

test('own images load inline as a path on this host; remote ones go through the proxy, or show as links without it', async () => {
  const link = '<a href="https://img.example/b.png" rel="noopener noreferrer nofollow ugc">remote</a>';
  expect((await createMarkdownRenderer(site)).render(images).html).toBe(
    `<p><img src="/media/a.png" alt="own" loading="lazy"> ${link}</p>\n`,
  );
  const proxy = (url: string) => `/media/proxy?url=${encodeURIComponent(url)}`;
  expect((await createMarkdownRenderer({ ...site, proxy })).render(images).html).toContain(
    '<img src="/media/proxy?url=https%3A%2F%2Fimg.example%2Fb.png" alt="remote" loading="lazy">',
  );
  expect(
    (await createMarkdownRenderer({ ...site, proxy, remoteMedia: false })).sanitize('<img src="https://img.example/b.png" alt="remote">')
      .html,
  ).toBe(link);
});
