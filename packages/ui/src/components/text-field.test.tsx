import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { alertsOf, controlTag, descriptionOf } from './field-markup.testing.ts';
import { TextField } from './text-field.tsx';

test('a valid field renders no error part and is described by its hint', () => {
  const html = renderToString(<TextField label="Host" name="domain" required description="Like example.com" />);
  expect(html).not.toContain('muxui-input__error');
  expect(alertsOf(html)).toEqual([]);
  expect(controlTag(html, 'input')).not.toContain('aria-invalid');
  expect(descriptionOf(html, 'input')).toContain('Like example.com');
});

test("the caller's message, while invalid, is an alert the input is described by", () => {
  const html = renderToString(<TextField label="Name" name="name" description="Lowercase" invalid errorMessage="That name is taken." />);
  expect(alertsOf(html)).toEqual(['That name is taken.']);
  expect(controlTag(html, 'input')).toContain('aria-invalid="true"');
  expect(descriptionOf(html, 'input')).toEqual(expect.arrayContaining(['Lowercase', 'That name is taken.']));
});

test('a message without the invalid flag is not shown, and the native limits reach the input', () => {
  const html = renderToString(
    <TextField label="Uses" name="uses" type="number" min={1} max={50} minLength={2} pattern="[0-9]+" errorMessage="Never shown" />,
  );
  expect(html).not.toContain('Never shown');
  const input = controlTag(html, 'input');
  // HTML attribute names ignore case; React writes this one as minLength.
  for (const attribute of [/ min="1"/, / max="50"/, / minlength="2"/i, / pattern="\[0-9\]\+"/]) expect(input).toMatch(attribute);
});
