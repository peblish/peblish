import { expect, test } from 'vitest';
import { renderMarkdown } from './render.ts';
import { sanitizeRemoteHtml } from './sanitize.ts';

// Timing (test group d). Times are the median or best of several runs after a warm-up, so a
// single slow run (JIT, GC) does not decide the result. The guarantee is linear time, so the
// adversarial shapes are checked as a scaling ratio, which holds on any hardware, and the
// realistic post only against a generous ceiling.

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

/** How much longer `run` takes on eight times the input, the best of five runs each. */
function scaling(run: (input: string) => unknown, make: (n: number) => string, n: number): number {
  const best = (input: string) => times(() => run(input), 5)[0]!;
  return best(make(8 * n)) / best(make(n));
}
// Linear is about 8 and quadratic about 64. With the whole suite running alongside, the
// shapes below measured 6 to 14 (GC grows with the heap), and each fixed regression, put
// back, 52 to 72.
const ratioBound = 20;

test('a 40,000-character post renders well within the ceiling', () => {
  let post = '';
  for (let i = 0; post.length < 40_000; i++) post += section(i);
  post = post.slice(0, 40_000);
  const median = times(() => renderMarkdown(post, { baseOrigin: 'https://feddit.example' }), 9)[4]!;
  // About 11 ms on the machine this was written on; the ceiling only catches a regression.
  expect(median).toBeLessThan(400);
});

// Shapes that make a naive stack quadratic (htmlparser2's Parser among them): deep nesting,
// end tags that match nothing, implied end tags, and plain bulk; and attribute values a
// backtracking pattern is slow on.
const shapes: Record<string, (n: number) => string> = {
  'deep nesting': (n) => `${'<div>'.repeat(n)}x`,
  'unmatched end tags': (n) => `${'<b>'.repeat(n)}${'</i>'.repeat(n)}`,
  'implied end tags': (n) => '<table><tr><td>'.repeat(n),
  'open inline elements': (n) => `${'<b><i>'.repeat(n)}x`,
  'many attributes': (n) => `<a ${'title="x" '.repeat(n)}href="https://a.example/">x</a>`,
  'links and text': (n) => '<p><a href="https://a.example/x?y=1">link</a> &amp; text</p>'.repeat(n),
  // A text-align style padded with spaces: a pattern with two adjacent whitespace runs backtracks on it.
  'padded cell style': (n) => `<table><tr><td style="text-align:left${' '.repeat(n)}x">c</td></tr></table>`,
};

test.each(Object.entries(shapes))('the sanitiser is linear in input size: %s', (_shape, make) => {
  expect(scaling((input) => sanitizeRemoteHtml(input, { maxLength: 10_000_000 }), make, 10_000)).toBeLessThan(ratioBound);
});

// Markdown shapes: deep nesting, bulk of each construct, and the shapes that made a plugin
// superlinear. n counts the repeated part.
const markdownShapes: Record<string, (n: number) => string> = {
  'nested quotes': (n) => `${'> '.repeat(n)}x`,
  'nested lists': (n) => `${'- '.repeat(n)}x`,
  'nested spoilers': (n) => `${'::: spoiler a\n'.repeat(n)}x${'\n:::'.repeat(n)}`,
  // The padded opening line is tested once per nesting level.
  'padded spoiler title, 40 deep': (n) => `${'::: spoiler a\n'.repeat(40)}::: spoiler x${' '.repeat(n)}y\n${':::\n'.repeat(41)}`,
  'many links': (n) => '[a](/x) https://a.example/ '.repeat(n),
  // Image sizing splits the alt text at `::`.
  'whitespace in image alt text': (n) => `![${' '.repeat(n)}](https://img.example/a.png)`,
  // Each new mention is checked against those already collected.
  'distinct mentions': (n) => Array.from({ length: n }, (_, i) => `@u${i}@lemmy.example`).join(' '),
  // markdown-it-footnote's own tail rule copied the token stream once per footnote.
  'many footnotes': (n) =>
    `${Array.from({ length: n }, (_, i) => `x[^${i}]`).join(' ')}\n\n${Array.from({ length: n }, (_, i) => `[^${i}]: note ${i}`).join('\n')}`,
  'many inline footnotes': (n) => 'x^[note] '.repeat(n),
  'long code span': (n) => `\`${'code '.repeat(n)}\``,
  'unmatched backtick runs': (n) => Array.from({ length: n }, (_, i) => '`'.repeat((i % 50) + 1)).join(' x '),
  'unmatched emphasis': (n) => `${'*'.repeat(n)}x${'_'.repeat(n)}`,
  // highlight.js is quadratic on a run of `$` in Java; these blocks are past the block cap.
  'two java blocks of $': (n) => `\`\`\`java\n${'$'.repeat(n)}\n\`\`\`\n\n\`\`\`java\n${'$'.repeat(n)}\n\`\`\``,
};

test.each(Object.entries(markdownShapes))('rendering is linear in input size: %s', (_shape, make) => {
  const render = (input: string) => renderMarkdown(input, { baseOrigin: 'https://feddit.example', maxLength: 10_000_000 });
  expect(scaling(render, make, 2_000)).toBeLessThan(ratioBound);
});
