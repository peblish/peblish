import { htmlMaxDepth } from '@peblish/schema/markdown';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, test } from 'vitest';
import { htmlVectors, markdownVectors, wrapperVectors } from './__fixtures__/xss.ts';
import { renderMarkdown } from './render.ts';
import { sanitizeRemoteHtml } from './sanitize.ts';

// The XSS corpus (test group b). Each output is parsed the way a browser parses innerHTML
// (parse5 follows the HTML standard), and the tree must hold no script, no element outside
// the allowlist, no event handler, no inline style, no URL other than http(s), mailto or a
// same-page fragment, and no element deeper than htmlMaxDepth. Re-sanitising an output must
// leave it unchanged. For the malformed wrappers, the tree a browser builds from the output
// must also be the tree the sanitiser wrote; the sanitiser does not promise that for every
// input (see sanitize.ts).

const elements = new Set(
  'p br hr h1 h2 h3 h4 h5 h6 strong b em i u s del ins sub sup code pre kbd blockquote ul ol li table thead tbody tfoot tr th td details summary img a span div section ruby rt rp'.split(
    ' ',
  ),
);
const attributes = new Set(['href', 'src', 'alt', 'title', 'class', 'id', 'width', 'height', 'align', 'start', 'rel', 'loading']);
const html = 'http://www.w3.org/1999/xhtml';

type Node = DefaultTreeAdapterTypes.ChildNode;

function problems(output: string): string[] {
  const found: string[] = [];
  const visit = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      if (!('tagName' in node)) continue;
      if (depth > htmlMaxDepth) found.push(`${node.tagName} at depth ${depth}`);
      if (node.namespaceURI !== html || !elements.has(node.tagName)) found.push(`element ${node.tagName}`);
      for (const { name, value } of node.attrs) {
        if (!attributes.has(name)) found.push(`attribute ${name} on ${node.tagName}`);
        if (name === 'href' || name === 'src') {
          const safe =
            (name === 'href' && /^#[\w:.-]+$/.test(value)) ||
            (URL.canParse(value) && ['https:', 'http:', ...(name === 'href' ? ['mailto:'] : [])].includes(new URL(value).protocol));
          if (!safe) found.push(`${name}="${value}"`);
        }
      }
      if (node.tagName === 'a' && node.attrs.some((a) => a.name === 'href' && !a.value.startsWith('#'))) {
        const rel = node.attrs.find((a) => a.name === 'rel')?.value;
        if (rel !== 'noopener noreferrer nofollow ugc') found.push(`rel="${rel}"`);
      }
      visit(node.childNodes, depth + 1);
    }
  };
  visit(parseFragment(output).childNodes, 1);
  return found;
}

const base = 'https://ok.example';
const paths = {
  remote: (input: string) => sanitizeRemoteHtml(input, { baseUrl: `${base}/post/1` }).html,
  markdown: (input: string) => renderMarkdown(input, { baseOrigin: base }).html,
};

describe.each(Object.entries(paths))('the %s path', (_path, run) => {
  test.each([...htmlVectors, ...wrapperVectors, ...markdownVectors].map((vector) => [vector.slice(0, 80), vector]))(
    '%s',
    (_label, vector) => {
      const output = run(vector);
      expect(problems(output)).toEqual([]);
      expect(sanitizeRemoteHtml(output, { baseUrl: base }).html).toBe(output);
    },
  );
});

// Writes a parsed tree out again the way the sanitiser writes its output.
const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const write = (nodes: Node[]): string =>
  nodes
    .map((node) => {
      if ('value' in node) return escapeText(node.value);
      if (!('tagName' in node)) return '';
      const attrs = node.attrs.map(({ name, value }) => ` ${name}="${escapeText(value).replace(/"/g, '&quot;')}"`).join('');
      return ['br', 'hr', 'img'].includes(node.tagName)
        ? `<${node.tagName}${attrs}>`
        : `<${node.tagName}${attrs}>${write(node.childNodes)}</${node.tagName}>`;
    })
    .join('');

test.each(wrapperVectors)('a browser builds the tree written for the malformed wrapper %s', (vector) => {
  for (const run of Object.values(paths)) {
    const output = run(vector);
    expect(write(parseFragment(output).childNodes)).toBe(output);
  }
});

test('hostile hooks cannot reintroduce what the allowlist removes', () => {
  const output = renderMarkdown(':text: :image: :relative: ![a](https://ok.example/a.png) ![b](https://ok.example/b.png)', {
    baseOrigin: base,
    emoji: { text: '<img src=x onerror=alert(1)>', image: { url: 'javascript:alert(1)' }, relative: { url: '//evil.example/e.png' } },
    rewriteImageUrl: (url) => (url.endsWith('a.png') ? 'javascript:alert(2)' : '//evil.example/b.png'),
  }).html;
  expect(problems(output)).toEqual([]);
  expect(output).not.toContain('evil.example');
  expect(output).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('the corpus exercises the cases it names', () => {
  // Spot checks that vectors reach the code they target, rather than failing to parse.
  expect(paths.remote('<a href="//evil.example/x">protocol relative</a>')).toBe('protocol relative');
  // Protocol-relative and backslashed URLs are refused before resolution, even onto the base's host.
  for (const href of [
    '//ok.example/x',
    '\\\\ok.example/x',
    '/\\ok.example/x',
    'https:\\\\evil.example/x',
    '&#92;&#92;ok.example/x',
    '/&#9;/ok.example/x',
  ]) {
    expect(paths.remote(`<a href="${href}">x</a>`)).toBe('x');
  }
  expect(paths.remote('<img src="//ok.example/a.png" alt="a">')).toBe('a');
  expect(paths.markdown('[x](//ok.example/x) ![y](//ok.example/a.png)')).toBe('<p>x y</p>\n');
  expect(paths.remote('<a href="/c/foo">relative</a>')).toContain(`href="${base}/c/foo"`);
  expect(paths.remote('<IMG SRC="jav&#x09;ascript:alert(\'XSS\');">')).toBe('');
  expect(paths.markdown('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>\n');
  expect(paths.remote('<td style="text-align:left;background:url(javascript:alert(1))">cell</td>')).toBe('<td>cell</td>');
});
