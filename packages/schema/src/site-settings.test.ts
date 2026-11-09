import { expect, test } from 'vitest';
import { killSwitches, siteSettings } from './site-settings.ts';

test('every kill switch is a boolean that defaults to a value its schema accepts', () => {
  for (const key of killSwitches) {
    expect(typeof siteSettings[key].default).toBe('boolean');
    expect(siteSettings[key].schema.allows(siteSettings[key].default)).toBe(true);
  }
});

test('the contact email is an address or empty', () => {
  const { schema } = siteSettings['contact.email'];
  expect(schema.allows('')).toBe(true);
  expect(schema.allows('abuse@feddit.test')).toBe(true);
  expect(schema.allows('not an address')).toBe(false);
});
