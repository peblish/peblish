import { expect, test } from 'vitest';
import { englishFieldLabels, explainValidity, type JudgedControl } from './field-problem.tsx';

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
