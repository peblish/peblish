import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { alertsOf, controlTag, descriptionOf } from './field-markup.testing.ts';
import { Select } from './select.tsx';

const months = ['January', 'February'];

test('a valid select renders no error part and is described by its hint', () => {
  const html = renderToString(<Select label="Month" name="month" required placeholder="" items={months} description="Your birth month" />);
  expect(html).not.toContain('muxui-select-native__error');
  expect(alertsOf(html)).toEqual([]);
  expect(controlTag(html, 'select')).not.toContain('aria-invalid');
  expect(descriptionOf(html, 'select')).toEqual(['Your birth month']);
});

test("the caller's message, while invalid, is an alert the select is described by, and not shown without the flag", () => {
  const html = renderToString(<Select label="Rule" name="rule" items={months} invalid errorMessage="Pick the rule it broke." />);
  expect(alertsOf(html)).toEqual(['Pick the rule it broke.']);
  expect(controlTag(html, 'select')).toContain('aria-invalid="true"');
  expect(descriptionOf(html, 'select')).toEqual(['Pick the rule it broke.']);
  expect(renderToString(<Select label="Rule" name="rule" items={months} errorMessage="Pick the rule it broke." />)).not.toContain(
    'Pick the rule',
  );
});
