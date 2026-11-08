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

test('marker lines inside fenced code do not open or close a spoiler', () => {
  const fenced = renderMarkdown('::: spoiler t\n```\n:::\n::: spoiler x\n```\nsecret\n:::\nafter', {
    baseOrigin: 'https://feddit.example',
  });
  expect(fenced.html).toBe(
    '<details><summary>t</summary>\n<pre><code>:::\n::: spoiler x\n</code></pre>\n<p>secret</p>\n</details>\n<p>after</p>\n',
  );
  expect(fenced.excerpt).toBe('t after');
  // Tildes, and a closing line shorter than the opening one, which does not close it.
  expect(html('::: spoiler t\n~~~~\n~~~\n:::\n~~~~\nsecret\n:::')).toBe(
    '<details><summary>t</summary>\n<pre><code>~~~\n:::\n</code></pre>\n<p>secret</p>\n</details>\n',
  );
  // Fences in a list item and in a nested one, four columns past the spoiler.
  expect(html('::: spoiler t\n- item\n  ```\n  :::\n  ```\n  - sub\n\n    ```\n    :::\n    ```\n:::\nafter')).toBe(
    '<details><summary>t</summary>\n<ul>\n<li>item<pre><code>:::\n</code></pre>\n<ul>\n<li>\n<p>sub</p>\n<pre><code>:::\n</code></pre>\n</li>\n</ul>\n</li>\n</ul>\n</details>\n<p>after</p>\n',
  );
  // An indented code block that shows a fence is not one.
  expect(html('::: spoiler t\n    ```\n:::\nafter')).toBe(
    '<details><summary>t</summary>\n<pre><code>```\n</code></pre>\n</details>\n<p>after</p>\n',
  );
});

test('a fence left open in a list item keeps the spoiler open: it runs on rather than ending early', () => {
  expect(html('::: spoiler t\n- item\n  ```\n  code\n- next\n:::\nafter')).not.toMatch(/<\/details>\n<p>after/);
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
