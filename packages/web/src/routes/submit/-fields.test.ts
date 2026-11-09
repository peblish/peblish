import { expect, test } from 'vitest';
import { firstProblem, type FieldValues } from './-fields.ts';

const ok: FieldValues = { creating: true, community: 'c', type: 'text', title: 'A title', url: '', body: '', hasImage: false };
const problem = (changes: Partial<FieldValues>) => firstProblem({ ...ok, ...changes });

test('a complete post has no problem, and problems come in the order the form shows its fields', () => {
  expect(problem({})).toBeNull();
  expect(problem({ community: null, title: '' })).toBe('community.required');
  expect(problem({ title: '' })).toBe('title.required');
  expect(problem({ type: 'link', url: 'nope', title: 'x'.repeat(201) })).toBe('title.too_long');
});

test('the title counts characters after whitespace is collapsed, not UTF-16 units', () => {
  expect(problem({ title: `${'\u{1F600}'.repeat(200)}` })).toBeNull();
  expect(problem({ title: `  ${'a '.repeat(100)}  ` })).toBeNull();
  expect(problem({ title: '\u{1F600}'.repeat(201) })).toBe('title.too_long');
  expect(problem({ title: ' \n\t ' })).toBe('title.required');
});

test('a new link post may leave its title for the linked page to give; an edit may not', () => {
  const link = { type: 'link', url: 'https://example.org/a', title: '' } as const;
  expect(problem(link)).toBeNull();
  expect(problem({ ...link, creating: false })).toBe('title.required');
});

test('a link needs an http or https address without credentials', () => {
  expect(problem({ type: 'link', url: '' })).toBe('url.required');
  for (const url of [
    'example.org',
    'ftp://example.org/a',
    'javascript:alert(1)',
    'https://user:pass@example.org/',
    `https://example.org/${'a'.repeat(2000)}`,
  ]) {
    expect(problem({ type: 'link', url }), url).toBe('url.invalid');
  }
  expect(problem({ type: 'link', url: ' http://example.org/a?b=1 ' })).toBeNull();
});

test('the body is limited to the Markdown cap for a text post, and an image post needs its file', () => {
  expect(problem({ body: 'x'.repeat(50_000) })).toBeNull();
  expect(problem({ body: 'x'.repeat(50_001) })).toBe('body.too_long');
  expect(problem({ type: 'image' })).toBe('image.required');
  expect(problem({ type: 'image', hasImage: true })).toBeNull();
  expect(problem({ type: 'image', creating: false })).toBeNull();
});
