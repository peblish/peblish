import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { alertsOf, controlTag, descriptionOf } from '../components/field-markup.testing.ts';
import { MarkdownEditor, type MarkdownEditorLabels } from './markdown-editor.tsx';

const labels: MarkdownEditorLabels = {
  toolbar: 'Formatting',
  bold: 'Bold',
  italic: 'Italic',
  strikethrough: 'Strikethrough',
  link: 'Link',
  quote: 'Quote',
  code: 'Code',
  bulletList: 'Bulleted list',
  numberedList: 'Numbered list',
  heading: 'Heading',
  spoiler: 'Spoiler',
  linkText: 'text',
  linkUrl: 'https://',
  view: 'View',
  write: 'Write',
  preview: 'Preview',
  previewLoading: 'Loading',
  previewEmpty: 'Nothing to preview',
  previewFailed: 'Preview failed',
};

const editor = (props: { invalid?: boolean; errorMessage?: string }) =>
  renderToString(
    <MarkdownEditor
      name="body"
      label="Body"
      value="text"
      onChange={() => {}}
      labels={labels}
      insertSpoiler={(value, start, end) => ({ value, selectionStart: start, selectionEnd: end })}
      renderPreview={async () => ''}
      {...props}
    />,
  );

// A scripts-off submission the server refused renders the error in the first markup: the text area
// must already be described by it, since nothing repairs the link without hydration.
test('an editor invalid from the first render is described by its error in the server markup', () => {
  const html = editor({ invalid: true, errorMessage: 'Use at most 40,000 characters.' });
  expect(alertsOf(html)).toEqual(['Use at most 40,000 characters.']);
  expect(controlTag(html, 'textarea')).toContain('aria-invalid="true"');
  expect(descriptionOf(html, 'textarea')).toEqual(['Use at most 40,000 characters.']);
});

test('a valid editor renders no error part', () => {
  const html = editor({});
  expect(html).not.toContain('muxui-text-area__error');
  expect(alertsOf(html)).toEqual([]);
});
