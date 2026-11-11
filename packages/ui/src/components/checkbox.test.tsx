import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Checkbox } from './checkbox.tsx';
import { alertsOf, controlTag, descriptionOf } from './field-markup.testing.ts';

test('an unticked required box renders no error part until a post is tried', () => {
  const html = renderToString(
    <Checkbox name="terms" required description="Read them first.">
      I agree
    </Checkbox>,
  );
  expect(html).not.toContain('muxui-checkbox-field__error');
  expect(alertsOf(html)).toEqual([]);
  expect(controlTag(html, 'input')).not.toContain('aria-invalid');
  expect(descriptionOf(html, 'input')).toEqual(['Read them first.']);
});

test("the caller's message, while invalid, is an alert the box is described by", () => {
  const html = renderToString(
    <Checkbox name="terms" required invalid errorMessage="Agree to the terms to create an account.">
      I agree
    </Checkbox>,
  );
  expect(alertsOf(html)).toEqual(['Agree to the terms to create an account.']);
  expect(descriptionOf(html, 'input')).toEqual(['Agree to the terms to create an account.']);
});
