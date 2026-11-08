import { mentionMaxCount } from '@peblish/schema/markdown';
import { expect, test } from 'vitest';
import { renderMarkdown } from './render.ts';

// renderMarkdown's options and results. Equivalence with the peers, the XSS corpus,
// spoilers and timing have their own files.

const origin = 'https://feddit.example';
const render = (source: string, options = {}) => renderMarkdown(source, { baseOrigin: origin, ...options });

test('mentions link to local pages and are collected once, outside code and link text', () => {
  const result = render(
    'Hi @Alice@lemmy.example, !tech@lemmy.example and @bob@feddit.example. @alice@LEMMY.example `@c@d.example` [@e@f.example](https://x.example/)',
  );
  expect(result.mentions).toEqual([
    { kind: 'person', name: 'Alice', host: 'lemmy.example' },
    { kind: 'community', name: 'tech', host: 'lemmy.example' },
    { kind: 'person', name: 'bob', host: 'feddit.example' },
  ]);
  expect(result.html).toContain(
    `<a href="${origin}/u/Alice@lemmy.example" class="u-url mention" rel="noopener noreferrer nofollow ugc">@Alice@lemmy.example</a>`,
  );
  expect(result.html).toContain(`<a href="${origin}/c/tech@lemmy.example" class="u-url community"`);
  expect(result.html).toContain(`<a href="${origin}/u/bob" class="u-url mention"`);
  expect(result.html).toContain('<code>@c@d.example</code>');
});

test('only the first mentionMaxCount distinct mentions are linked and collected', () => {
  const names = Array.from({ length: mentionMaxCount + 5 }, (_, i) => `@u${i}@lemmy.example`);
  const result = render(`${names.join(' ')} @U0@lemmy.example`);
  expect(result.mentions).toHaveLength(mentionMaxCount);
  expect(result.mentions.at(-1)).toEqual({ kind: 'person', name: `u${mentionMaxCount - 1}`, host: 'lemmy.example' });
  // The repeat of a collected mention is still linked; the new ones past the cap are text.
  expect(result.html.match(/class="u-url mention"/g)).toHaveLength(mentionMaxCount + 1);
  expect(result.html).toContain(` @u${mentionMaxCount}@lemmy.example @u${mentionMaxCount + 1}@lemmy.example`);
});

test('links are absolute, in order, without duplicates, mentions or footnote anchors', () => {
  const result = render(
    '[a](/c/local) https://b.example/x [again](https://b.example/x) <mailto:m@b.example> @u@b.example note[^1]\n\n[^1]: [c](https://c.example/)',
  );
  expect(result.links).toEqual([`${origin}/c/local`, 'https://b.example/x', 'mailto:m@b.example', 'https://c.example/']);
  expect(result.html).toContain(`<a href="${origin}/c/local" rel="noopener noreferrer nofollow ugc">a</a>`);
});

test('the excerpt is plain text without spoiler bodies or footnotes, cut on a word', () => {
  const result = render('# Title\n\nSome *very* important\ntext.[^1]\n\n::: spoiler Twist\nThe secret.\n:::\n\n[^1]: A footnote.', {
    excerptLength: 40,
  });
  expect(result.excerpt).toBe('Title Some very important text. Twist');
  expect(render('word '.repeat(20), { excerptLength: 22 }).excerpt).toBe('word word word word…');
});

test('the link image policy shows images as links, and as their alt text inside a link', () => {
  const result = render('![A cat](https://img.example/cat.png) [![logo](https://img.example/l.png)](https://site.example/)', {
    images: 'link',
  });
  expect(result.html).toBe(
    '<p><a href="https://img.example/cat.png" rel="noopener noreferrer nofollow ugc">A cat</a> <a href="https://site.example/" rel="noopener noreferrer nofollow ugc">logo</a></p>\n',
  );
});

test('the rewrite hook decides where inline images load from, or turns them into links', () => {
  const rewriteImageUrl = (url: string) => (url.includes('blocked') ? null : `/media/proxy?url=${encodeURIComponent(url)}`);
  const result = render('![a](https://img.example/a.png) ![b](https://blocked.example/b.png)', { rewriteImageUrl });
  expect(result.html).toBe(
    '<p><img src="/media/proxy?url=https%3A%2F%2Fimg.example%2Fa.png" alt="a" loading="lazy"> <a href="https://blocked.example/b.png" rel="noopener noreferrer nofollow ugc">b</a></p>\n',
  );
});

test('emoji shortcodes map through the table; others stay as typed', () => {
  const emoji = { wave: '👋', blob: { url: 'https://feddit.example/emoji/blob.png' } };
  expect(render('Hi :wave: :blob: :nope:', { emoji }).html).toBe(
    '<p>Hi 👋 <img src="https://feddit.example/emoji/blob.png" alt=":blob:" title=":blob:" class="emoji" loading="lazy"> :nope:</p>\n',
  );
  expect(render(':blob:', { emoji, images: 'link' }).html).toBe('<p>:blob:</p>\n');
});

test('code blocks in a known language are highlighted; others stay plain', () => {
  expect(render('```ts\nconst a = 1;\n```').html).toBe(
    '<pre><code class="language-ts"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;\n</code></pre>\n',
  );
  expect(render('```nonsense\n<a>\n```').html).toBe('<pre><code class="language-nonsense">&lt;a&gt;\n</code></pre>\n');
});

test('idPrefix namespaces footnote anchors', () => {
  expect(render('x[^1]\n\n[^1]: y', { idPrefix: 'c42' }).html).toContain('<a id="fnref-c42-1" href="#fn-c42-1">[1]</a>');
});

test('deeply nested Markdown keeps its text', () => {
  const result = render(`${'> '.repeat(40)}deep quote\n\n${'- '.repeat(20)}deep list`);
  expect(result.html).toContain('deep quote');
  expect(result.html).toContain('deep list');
});

test('a source over maxLength is cut and flagged', () => {
  const result = render('abcdef', { maxLength: 3 });
  expect(result).toMatchObject({ html: '<p>abc</p>\n', truncated: true });
  expect(render('abc', { maxLength: 3 }).truncated).toBe(false);
});

test('options are validated', () => {
  expect(() => render('x', { baseOrigin: 'not a url' })).toThrow(/baseOrigin/);
  expect(() => render('x', { idPrefix: 'a b' })).toThrow(/idPrefix/);
});
