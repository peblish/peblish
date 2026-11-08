import { parseDocument } from 'htmlparser2';
import { describe, expect, test } from 'vitest';
import peers from './__fixtures__/peers.json' with { type: 'json' };
import { renderMarkdown } from './render.ts';
import { sanitizeRemoteHtml } from './sanitize.ts';

// Equivalence with the peers (test group a). Each fixture pairs a Markdown source with the
// `content` Lemmy 0.19.21 and PieFed 1.8.11 federated for it (lab captures, plus the
// peer-authored pairs in the Phase 0 spike captures; __fixtures__/capture.ts made them).
// Both sides are compared as a reader sees them: the peer's HTML through our sanitiser,
// then both normalised by `canonical` below. Every case either matches or is listed in
// `accepted` with the reason; an accepted difference that disappears fails the test too, so
// the list stays true.

type Peer = 'lemmy' | 'piefed';
const origins: Record<Peer, string> = { lemmy: 'https://lemmy.lab.test', piefed: 'https://piefed.lab.test' };

const beautified =
  "Lemmy's server shows autolinks as host and path (beautify_links); we show the URL as written, as lemmy-ui and PieFed do";
const mentionLinks = 'We link mentions to their local pages, as lemmy-ui does in the browser; neither server links them in content';
const tightItems = "PieFed's markdown2 wraps the text of a list item that holds a nested block in <p>";
const noSizeSyntax = 'Neither peer has a `=WxH` image size syntax; Lemmy linkifies the URL, PieFed puts the size into src (a broken image)';

const accepted: Record<Peer, Record<string, string>> = {
  lemmy: {
    footnote: "Lemmy's server renders no footnotes (lemmy-ui does, with markdown-it-footnote like us)",
    'sub-sup': "Lemmy's server renders no sub or superscript (lemmy-ui does, with the same plugins as us)",
    'sup-spaces': "Lemmy's server renders no superscript, so an escaped space stays a backslash",
    'spoiler-untitled': 'Lemmy needs a title on the opening line; we default it to Spoiler, as PieFed does',
    'spoiler-nested': 'Lemmy closes a spoiler at the first closing line; ours nest, as on PieFed',
    'image-size-equals': beautified,
    'image-size-equals-width': beautified,
    'image-size-title': beautified,
    'autolink-bare': beautified,
    'autolink-angle': beautified,
    'autolink-trailing': beautified,
    'link-parens': beautified,
    'mention-user': mentionLinks,
    'mention-community': mentionLinks,
    'image-size-piefed': "Lemmy has no image size syntax and keeps PieFed's `:: width=` words in the alt text",
    'image-size-percent': "Lemmy has no image size syntax and keeps PieFed's `:: width=` words in the alt text",
    'emoji-custom-lemmy':
      'We mark Lemmy custom emoji images (title "emoji <shortcode>") with class emoji; lemmy-ui wraps them in span.icon-emoji',
  },
  piefed: {
    lists: `${tightItems}; it also drops the ordered list's start number and joins lists that switch bullet characters`,
    'blockquote-list': tightItems,
    'indented-code': 'PieFed appends a stray closing tag to an indented code block that contains <x>',
    table: 'PieFed drops column alignment and the empty cell of a short row',
    footnote: "PieFed's footnotes use markdown2's markup (numbered captions without brackets, a div instead of a section, other ids)",
    'image-size-equals': noSizeSyntax,
    'image-size-equals-width': noSizeSyntax,
    'image-size-title': noSizeSyntax,
    'autolink-bare': 'PieFed also links bare www. hosts; we link only URLs with a scheme, as Lemmy does',
    'autolink-angle': 'PieFed does not link <user@host> email autolinks',
    'link-title': "PieFed's allowlist drops the title of a link",
    'raw-html-block': 'PieFed lets allowlisted HTML through; we escape all raw HTML, as Lemmy does',
    typographer: 'PieFed turns quotes and dashes into typographic ones but not (c), (tm) or +-',
    ruby: 'PieFed renders {base|ruby} as <ruby>; neither we nor Lemmy have ruby',
    'javascript-link':
      'PieFed links the text with an empty href and keeps a javascript: image src (our sanitiser drops both); we leave it as text',
    'data-link': 'PieFed links a data: URL (our sanitiser drops it); we leave it as text',
    'table-inline-html': "PieFed lets a raw <img> into the cell and breaks the row's structure; we escape it",
    'mention-user': mentionLinks,
    'mention-community': mentionLinks,
    'sup-spaces': 'PieFed renders no superscript with an escaped space',
    'reddit-spoiler': "PieFed renders Reddit's >!inline spoiler!<; we do not (yet), so it stays text",
    'fenced-tilde': 'PieFed does not support ~~~ fences and reads them as strikethrough',
    'emoji-custom-lemmy': 'We mark Lemmy custom emoji images (title "emoji <shortcode>") with class emoji; PieFed does not',
  },
};

/** Text with the markup characters escaped, so decoded text cannot pose as a tag. */
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Node = ReturnType<typeof parseDocument>['children'][number];
const textOf = (nodes: Node[]): string =>
  nodes.map((node) => ('data' in node && node.type === 'text' ? node.data : 'children' in node ? textOf(node.children) : '')).join('');

function serialize(nodes: Node[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' && 'data' in node) return escape(node.data);
      if (!('attribs' in node)) return '';
      // Highlighting differs by design (syntect inline styles, Pygments classes, hljs classes):
      // a code block compares by its text.
      if (node.name === 'pre') return `<pre>${escape(textOf(node.children).replace(/^\n/, '').replace(/\n$/, ''))}</pre>`;
      const attributes = Object.entries(node.attribs).filter(([name]) => name !== 'rel' && name !== 'loading');
      // Wrappers that carry nothing once sanitised: PieFed's spoiler and footnote divs.
      if ((node.name === 'div' || node.name === 'span') && attributes.length === 0) return serialize(node.children);
      const pairs = attributes.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ` ${name}="${escape(value)}"`);
      return `<${node.name}${pairs.join('')}>${serialize(node.children)}</${node.name}>`;
    })
    .join('');
}

const block = '(?:p|li|ul|ol|blockquote|h[1-6]|table|thead|tbody|tr|th|td|details|summary|pre|hr|section|div)';
/** Sanitised HTML in a canonical form: sorted attributes, no whitespace around blocks. */
function canonical(html: string): string {
  return serialize(parseDocument(html).children)
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`\\s*(</?${block}\\b[^>]*>)\\s*`, 'g'), '$1')
    .trim();
}

const ours = (source: string, peer: Peer) => canonical(renderMarkdown(source, { baseOrigin: origins[peer] }).html);
const theirs = (content: string, peer: Peer) => canonical(sanitizeRemoteHtml(content, { baseUrl: `${origins[peer]}/post/1` }).html);

describe.each(['lemmy', 'piefed'] as const)('rendering the source matches what %s federates', (peer) => {
  test.each(peers.cases.map((c) => [c.id, c] as const))('%s', (id, c) => {
    const reason = accepted[peer][id];
    if (reason) expect(ours(c.source, peer), reason).not.toBe(theirs(c[peer], peer));
    else expect(ours(c.source, peer)).toBe(theirs(c[peer], peer));
  });

  test('the peer-authored pairs from the spike captures', () => {
    const pairs = peers.spike.filter((pair) => pair.peer === peer);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) expect(ours(pair.source, peer), pair.file).toBe(theirs(pair.content, peer));
  });
});

test('every accepted difference names a captured case', () => {
  const ids = new Set(peers.cases.map((c) => c.id));
  expect([...Object.keys(accepted.lemmy), ...Object.keys(accepted.piefed)].filter((id) => !ids.has(id))).toEqual([]);
});
