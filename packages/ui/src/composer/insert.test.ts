import { expect, test } from 'vitest';
import { bulletList, code, heading, link, numberedList, quote, wrap, type Insert } from './insert.ts';

// A text with its selection drawn in: `[..]` is a selection, `|` a caret. The result is drawn the same way.
function run(insert: Insert, drawn: string): string {
  const start = drawn.replace('[', '|').indexOf('|');
  const text = drawn.replace('[', '').replace(']', '').replace('|', '');
  const end = drawn.includes('[') ? drawn.indexOf(']') - 1 : start;
  const result = insert(text, start, end);
  const { value, selectionStart, selectionEnd } = result;
  return selectionStart === selectionEnd
    ? `${value.slice(0, selectionStart)}|${value.slice(selectionStart)}`
    : `${value.slice(0, selectionStart)}[${value.slice(selectionStart, selectionEnd)}]${value.slice(selectionEnd)}`;
}

test('bold, italic, strikethrough and inline code wrap the selection, or a caret, and keep the inner text selected', () => {
  expect(run(wrap('**'), 'a [word] b')).toBe('a **[word]** b');
  expect(run(wrap('*'), 'a| b')).toBe('a*|* b');
  expect(run(wrap('~~'), '[x]')).toBe('~~[x]~~');
  expect(run(code, 'run [npm test] now')).toBe('run `[npm test]` now');
});

test('a link takes the selection as its text, or a selected address as its target', () => {
  const insert = link({ text: 'text', url: 'https://' });
  expect(run(insert, 'see [the docs] here')).toBe('see [the docs]([https://]) here');
  expect(run(insert, 'see | here')).toBe('see [text]([https://]) here');
  expect(run(insert, 'see [https://example.org/a] here')).toBe('see [[text]](https://example.org/a) here');
});

test('quote and the lists prefix every line the selection touches, and nothing else; the selection stays on its text', () => {
  expect(run(quote, 'one\ntw[o\nthr]ee\nfour')).toBe('one\n> tw[o\n> thr]ee\nfour');
  expect(run(bulletList, 'a|b')).toBe('- a|b');
  expect(run(numberedList, '[x\ny\nz]')).toBe('1. [x\n2. y\n3. z]');
  // A selection that ends right after a line break leaves the next line alone.
  expect(run(bulletList, '[one\n]two')).toBe('- [one\n]two');
});

test('a heading marks the first line, once', () => {
  expect(run(heading, 'intro\nab|c')).toBe('intro\n## ab|c');
  expect(run(heading, '## ti|tle')).toBe('## ti|tle');
  expect(run(heading, '|\ntext')).toBe('## |\ntext');
});

test('code over several lines becomes a fenced block set apart from its text', () => {
  expect(run(code, 'before\n[a\nb]\nafter')).toBe('before\n\n```\n[a\nb]\n```\n\nafter');
  expect(run(code, '[a\nb]')).toBe('```\n[a\nb]\n```');
});
