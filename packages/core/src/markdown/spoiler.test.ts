import { expect, test } from 'vitest';
import { renderMarkdown } from './render.ts';
import { insertSpoiler } from './toolbar.ts';

// Spoiler rendering and the composer's insertion format (test group c).

const html = (source: string) => renderMarkdown(source, { baseOrigin: 'https://feddit.example' }).html;

test('a spoiler renders as details with an escaped summary and a Markdown body', () => {
  expect(html('::: spoiler Ending <b>&</b>\nThe *butler* did it.\n\nTwice.\n:::')).toBe(
    '<details><summary>Ending &lt;b&gt;&amp;&lt;/b&gt;</summary>\n<p>The <em>butler</em> did it.</p>\n<p>Twice.</p>\n</details>\n',
  );
});

test('spoilers nest, default their title, interrupt a paragraph and run to the end when unclosed', () => {
  expect(html('before\n::: spoiler\nouter\n::: spoiler inner\nhidden\n:::\nafter inner\n:::\nafter')).toBe(
    '<p>before</p>\n<details><summary>Spoiler</summary>\n<p>outer</p>\n<details><summary>inner</summary>\n<p>hidden</p>\n</details>\n<p>after inner</p>\n</details>\n<p>after</p>\n',
  );
  expect(html('::: spoiler open\nnever closed\n\nstill hidden')).toBe(
    '<details><summary>open</summary>\n<p>never closed</p>\n<p>still hidden</p>\n</details>\n',
  );
});

test('a spoiler works inside a list item or quote, and not inside code', () => {
  expect(html('- item\n\n  ::: spoiler t\n  hidden\n  :::\n- next')).toContain(
    '<li>\n<p>item</p>\n<details><summary>t</summary>\n<p>hidden</p>\n</details>\n</li>',
  );
  expect(html('> ::: spoiler t\n> hidden\n> :::')).toBe(
    '<blockquote>\n<details><summary>t</summary>\n<p>hidden</p>\n</details>\n</blockquote>\n',
  );
  expect(html('```\n::: spoiler t\n:::\n```')).toBe('<pre><code>::: spoiler t\n:::\n</code></pre>\n');
});

test('the toolbar wraps the selection in its own block and selects the title', () => {
  const value = 'Who did it? The butler. Really.';
  const start = value.indexOf('The butler.');
  const result = insertSpoiler(value, start, start + 'The butler.'.length, 'Ending');
  expect(result.value).toBe('Who did it? \n\n::: spoiler Ending\nThe butler.\n:::\n\n Really.');
  expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe('Ending');
  expect(html(result.value)).toContain('<details><summary>Ending</summary>\n<p>The butler.</p>\n</details>');
});

test('without a selection the toolbar inserts an empty body and puts the caret in it', () => {
  const result = insertSpoiler('First line\n', 11, 11);
  expect(result.value).toBe('First line\n\n::: spoiler Spoiler\n\n:::');
  expect(result.selectionStart).toBe(result.selectionEnd);
  expect(result.value.slice(0, result.selectionStart)).toBe('First line\n\n::: spoiler Spoiler\n');
  expect(insertSpoiler('', 0, 0, ' Two\nlines ').value).toBe('::: spoiler Two lines\n\n:::');
});
