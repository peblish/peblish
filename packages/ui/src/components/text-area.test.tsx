import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { alertsOf, controlTag, descriptionOf } from './field-markup.testing.ts';
import { TextAreaField } from './text-area.tsx';

test('a valid text area renders no error part and is described by its hint', () => {
  const html = renderToString(<TextAreaField label="Reason" name="reason" required maxLength={10000} description="The author is told." />);
  expect(html).not.toContain('muxui-text-area__error');
  expect(alertsOf(html)).toEqual([]);
  expect(controlTag(html, 'textarea')).not.toContain('aria-invalid');
  expect(descriptionOf(html, 'textarea')).toEqual(['The author is told.']);
});

test("the caller's message, while invalid, is an alert the text area is described by", () => {
  const html = renderToString(<TextAreaField label="Reply" name="body" invalid errorMessage="Could not send." />);
  expect(alertsOf(html)).toEqual(['Could not send.']);
  expect(controlTag(html, 'textarea')).toContain('aria-invalid="true"');
  expect(descriptionOf(html, 'textarea')).toEqual(['Could not send.']);
});
