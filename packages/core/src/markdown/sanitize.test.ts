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

test('input over maxLength is cut (here inside a tag) and flagged, and nothing is left open', () => {
  expect(sanitizeRemoteHtml('<p><b>bold</b> and <i>more', { maxLength: 21 })).toMatchObject({
    html: '<p><b>bold</b> and </p>',
    truncated: true,
  });
  expect(sanitizeRemoteHtml('<p><b>x', {})).toMatchObject({ html: '<p><b>x</b></p>', truncated: false });
});
