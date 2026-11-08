import { htmlMaxDepth } from '@peblish/schema/markdown';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { expect, test } from 'vitest';
import { sanitizeRemoteHtml } from './sanitize.ts';

// sanitizeRemoteHtml on the shapes peers send. The XSS corpus and the peer equivalence
// suite cover the rest.

test('a Mastodon note keeps its mention, hashtag and link-shortening markup', () => {
  const note =
    '<p><span class="h-card" translate="no"><a href="https://mastodon.example/@ann" class="u-url mention">@<span>ann</span></a></span> see ' +
    '<a href="https://news.example/a/very/long/path" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">https://</span><span class="ellipsis">news.example/a/very</span><span class="invisible">/long/path</span></a> ' +
    '<a href="https://mastodon.example/tags/fedi" class="mention hashtag" rel="tag">#<span>fedi</span></a></p>';
  const result = sanitizeRemoteHtml(note);
  expect(result.html).toBe(
    '<p><span class="h-card"><a href="https://mastodon.example/@ann" class="u-url mention" rel="noopener noreferrer nofollow ugc">@<span>ann</span></a></span> see ' +
      '<a href="https://news.example/a/very/long/path" rel="noopener noreferrer nofollow ugc"><span class="invisible">https://</span><span class="ellipsis">news.example/a/very</span><span class="invisible">/long/path</span></a> ' +
      '<a href="https://mastodon.example/tags/fedi" class="mention hashtag" rel="noopener noreferrer nofollow ugc">#<span>fedi</span></a></p>',
  );
  expect(result.links).toEqual(['https://news.example/a/very/long/path']);
  expect(result.excerpt).toBe('@ann see news.example/a/very #fedi');
});

test("PieFed's inline spoilers, in both forms, stay out of the excerpt", () => {
  for (const spoiler of ['<tg-spoiler>he lives</tg-spoiler>', '<span class="spoiler">he lives</span>']) {
    const result = sanitizeRemoteHtml(`<p>The end: ${spoiler}.</p>`);
    expect(result.html).toBe('<p>The end: <span class="spoiler">he lives</span>.</p>');
    expect(result.excerpt).toBe('The end: .');
  }
});

test('relative URLs resolve against baseUrl and must stay on its origin', () => {
  const html = '<a href="/c/tech">community</a> <a href="//evil.example/">away</a> <img src="/pictrs/a.png" alt="a">';
  expect(sanitizeRemoteHtml(html, { baseUrl: 'https://lemmy.example/post/1' }).html).toBe(
    '<a href="https://lemmy.example/c/tech" rel="noopener noreferrer nofollow ugc">community</a> away <img src="https://lemmy.example/pictrs/a.png" alt="a" loading="lazy">',
  );
  expect(sanitizeRemoteHtml(html).html).toBe('community away a');
});

test("Lemmy's inline styles become nothing, except table alignment, which becomes align", () => {
  const lemmy =
    '<table><tr><th style="text-align:center">h</th></tr></table><pre style="background-color:#ffffff;"><span style="color:#323232;">x</span></pre>';
  expect(sanitizeRemoteHtml(lemmy).html).toBe('<table><tr><th align="center">h</th></tr></table><pre><span>x</span></pre>');
});

test('images follow the policy and the rewrite hook, as in renderMarkdown', () => {
  const html = '<p><img src="https://img.example/a.png" alt="a" width="200px" height="9999999"></p>';
  expect(sanitizeRemoteHtml(html, { rewriteImageUrl: (url) => `https://proxy.example/?u=${encodeURIComponent(url)}` }).html).toBe(
    '<p><img src="https://proxy.example/?u=https%3A%2F%2Fimg.example%2Fa.png" alt="a" width="200" loading="lazy"></p>',
  );
  expect(sanitizeRemoteHtml(html, { images: 'link' }).html).toBe(
    '<p><a href="https://img.example/a.png" rel="noopener noreferrer nofollow ugc">a</a></p>',
  );
});

test('elements deeper than maxDepth are unwrapped, keeping their text', () => {
  expect(
    sanitizeRemoteHtml('<blockquote><blockquote><blockquote><p><b>deep</b></p></blockquote></blockquote></blockquote>', { maxDepth: 2 })
      .html,
  ).toBe('<blockquote><blockquote>deep</blockquote></blockquote>');
});

/** The deepest element in the tree a browser builds from `html`. */
function browserDepth(html: string): number {
  const deepest = (nodes: DefaultTreeAdapterTypes.ChildNode[]): number =>
    Math.max(0, ...nodes.map((node) => ('childNodes' in node ? 1 + deepest(node.childNodes) : 0)));
  return deepest(parseFragment(html).childNodes);
}

test('the depth cap holds in the tree a browser builds, and a second pass changes nothing', () => {
  const divs = (n: number, inner: string) => `${'<div>'.repeat(n)}${inner}${'</div>'.repeat(n)}`;
  // At the cap an image shows its alt text, not a link one level deeper.
  const image = divs(32, '<img src="https://ok.example/a.png" alt="a">');
  expect(sanitizeRemoteHtml(image).html).toBe(divs(32, 'a'));
  // The browser puts a tbody above the row, so the cell would be at depth 33.
  const table = divs(29, '<table><tr><td>x</td></tr></table>');
  expect(sanitizeRemoteHtml(table).html).toBe(divs(29, '<table><tr>x</tr></table>'));
  for (const input of [image, table]) {
    const once = sanitizeRemoteHtml(input).html;
    expect(browserDepth(once)).toBeLessThanOrEqual(htmlMaxDepth);
    expect(sanitizeRemoteHtml(once).html).toBe(once);
  }
});

test('input over maxLength is cut (here inside a tag) and flagged, and nothing is left open', () => {
  expect(sanitizeRemoteHtml('<p><b>bold</b> and <i>more', { maxLength: 21 })).toMatchObject({
    html: '<p><b>bold</b> and </p>',
    truncated: true,
  });
  expect(sanitizeRemoteHtml('<p><b>x', {})).toMatchObject({ html: '<p><b>x</b></p>', truncated: false });
});
