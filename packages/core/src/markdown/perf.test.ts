import { expect, test } from 'vitest';
import { renderMarkdown } from './render.ts';
import { sanitizeRemoteHtml } from './sanitize.ts';

// Timing (test group d). Times are the median or best of several runs after a warm-up, so a
// single slow run (JIT, GC) does not decide the result.

/** One section of a realistic post: every dialect feature, about 900 characters. */
const section = (i: number) => `## Section ${i}

Some **bold** and *italic* text with a [link](https://example.com/${i}) and https://example.org/path/${i}, a mention of
@user${i}@lemmy.example and !community@piefed.example, H~2~O and x^2^, ~~struck~~ and \`inline code\`. "Quotes" -- (c).[^n${i}]

- first item with *emphasis*
- second item
  - nested item
1. one
2. two

> A quote with a [reference link][r${i}].

\`\`\`js
function add${i}(a, b) {
  return a + b; // comment ${i}
}
\`\`\`

| Name | Value |
| :--- | ---: |
| a${i} | ${i} |
| b | **c** |

::: spoiler Spoiler ${i}
Hidden *text* number ${i}.
:::

![image ${i}](https://img.example/${i}.png)

[r${i}]: https://example.net/${i}
[^n${i}]: Footnote ${i}.

`;

function times(run: () => void, count: number): number[] {
  for (let i = 0; i < 3; i++) run();
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    run();
    result.push(performance.now() - start);
  }
  return result.sort((a, b) => a - b);
}

test('a 40,000-character post renders in under 50 ms', () => {
  let post = '';
  for (let i = 0; post.length < 40_000; i++) post += section(i);
  post = post.slice(0, 40_000);
  const median = times(() => renderMarkdown(post, { baseOrigin: 'https://feddit.example' }), 9)[4]!;
  expect(median).toBeLessThan(50);
});

// Shapes that make a naive stack quadratic (htmlparser2's Parser among them): deep nesting,
// end tags that match nothing, implied end tags, and plain bulk.
const shapes: Record<string, (n: number) => string> = {
  'deep nesting': (n) => `${'<div>'.repeat(n)}x`,
  'unmatched end tags': (n) => `${'<b>'.repeat(n)}${'</i>'.repeat(n)}`,
  'implied end tags': (n) => '<table><tr><td>'.repeat(n),
  'open inline elements': (n) => `${'<b><i>'.repeat(n)}x`,
  'many attributes': (n) => `<a ${'title="x" '.repeat(n)}href="https://a.example/">x</a>`,
  'links and text': (n) => '<p><a href="https://a.example/x?y=1">link</a> &amp; text</p>'.repeat(n),
  // A text-align style padded with spaces, which a regex with two adjacent \s* runs backtracks on.
  'padded cell style': (n) => `<table><tr><td style="text-align:left${' '.repeat(n)}x">c</td></tr></table>`,
};

test.each(Object.entries(shapes))('the sanitiser is linear in input size: %s', (_shape, make) => {
  const small = make(10_000);
  const large = make(80_000);
  const best = (input: string) => times(() => sanitizeRemoteHtml(input, { maxLength: 10_000_000 }), 5)[0]!;
  // Eight times the input: linear is about 8, quadratic about 64.
  expect(best(large) / best(small)).toBeLessThan(24);
});

// Markdown shapes that made a plugin superlinear. Each takes n, the size of the small input
// in units of its repeated part.
const markdownShapes: Record<string, (n: number) => string> = {
  // The padded opening line is tested once per nesting level.
  'padded spoiler title, 40 deep': (n) => `${'::: spoiler a\n'.repeat(40)}::: spoiler x${' '.repeat(n)}y\n${':::\n'.repeat(41)}`,
  // Image sizing splits the alt text at `::`.
  'whitespace in image alt text': (n) => `![${' '.repeat(n)}](https://img.example/a.png)`,
};

test.each(Object.entries(markdownShapes))('rendering is linear in input size: %s', (_shape, make) => {
  const best = (input: string) =>
    times(() => renderMarkdown(input, { baseOrigin: 'https://feddit.example', maxLength: 10_000_000 }), 5)[0]!;
  // Eight times the input: linear is about 8, quadratic about 64.
  expect(best(make(16_000)) / best(make(2_000))).toBeLessThan(24);
});
