import { expect, test } from 'vitest';
import { englishFieldLabels, explainValidity, nextProblem, type JudgedControl } from './field-problem.tsx';

const valid: JudgedControl['validity'] = {
  valueMissing: false,
  typeMismatch: false,
  tooShort: false,
  tooLong: false,
  patternMismatch: false,
  rangeUnderflow: false,
  rangeOverflow: false,
  badInput: false,
  stepMismatch: false,
};
const judge = (
  type: string,
  flags: Partial<JudgedControl['validity']>,
  limits: Omit<JudgedControl, 'type' | 'validity'> = {},
  locale = 'en',
) => explainValidity({ type, validity: { ...valid, ...flags }, ...limits }, { ...englishFieldLabels, locale });

test('each validity state has its own message, with the limit where there is one', () => {
  expect(judge('text', {})).toBeUndefined();
  expect(judge('text', { valueMissing: true })).toBe('Fill in this field.');
  expect(judge('textarea', { valueMissing: true })).toBe('Fill in this field.');
  expect(judge('checkbox', { valueMissing: true })).toBe('Tick this box to continue.');
  expect(judge('select-one', { valueMissing: true })).toBe('Choose an option.');
  expect(judge('email', { typeMismatch: true })).toBe('Enter an email address, like name@example.com.');
  expect(judge('url', { typeMismatch: true })).toBe('Enter a full link, like https://example.com.');
  expect(judge('password', { tooShort: true }, { minLength: 12 })).toBe('Use at least 12 characters.');
  expect(judge('textarea', { tooLong: true }, { maxLength: 10000 })).toBe('Use at most 10,000 characters.');
  expect(judge('text', { patternMismatch: true })).toBe('Use the format shown.');
  expect(judge('number', { rangeUnderflow: true }, { min: '1' })).toBe('Enter 1 or more.');
  expect(judge('number', { rangeOverflow: true }, { max: '5000' })).toBe('Enter 5,000 or less.');
  expect(judge('number', { badInput: true })).toBe('Check what you entered here.');
  expect(judge('number', { stepMismatch: true })).toBe('Check what you entered here.');
});

test('a missing value is named before any other problem, and limits follow the locale', () => {
  expect(judge('email', { valueMissing: true, typeMismatch: true })).toBe('Fill in this field.');
  expect(judge('textarea', { tooLong: true }, { maxLength: 10000 }, 'de-DE')).toBe('Use at most 10.000 characters.');
});

test('a blocked submit or a committed edit shows the verdict; a keystroke only clears a message, once the value is valid', () => {
  const required = 'Fill in this field.';
  const email = 'Enter an email address, like name@example.com.';
  // A field nobody has found wrong says nothing while it is typed in, even with an invalid value.
  expect(nextProblem('input', undefined, email)).toBeUndefined();
  // Found wrong by a blocked submit, or by leaving the field after an edit.
  expect(nextProblem('invalid', undefined, required)).toBe(required);
  expect(nextProblem('change', undefined, email)).toBe(email);
  // Typing a value that is still wrong keeps the message as it is, until the next commit re-judges it.
  expect(nextProblem('input', required, email)).toBe(required);
  expect(nextProblem('change', required, email)).toBe(email);
  // The keystroke that makes it valid takes the message away, before the field is left: the press
  // on the submit button that leaves it then moves nothing, so its click is not lost.
  expect(nextProblem('input', required, undefined)).toBeUndefined();
  expect(nextProblem('change', undefined, undefined)).toBeUndefined();
  expect(nextProblem('reset', required, required)).toBeUndefined();
});
