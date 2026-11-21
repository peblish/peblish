import { expect, test } from 'vitest';
import { killSwitches, siteSettings, type SiteSettingKey } from './site-settings.ts';

test("every key's default passes its own schema", () => {
  for (const key of Object.keys(siteSettings) as SiteSettingKey[]) {
    expect(siteSettings[key].schema.allows(siteSettings[key].default), key).toBe(true);
  }
});

test('the brand is a checked-in pack or none, and the width one of three presets', () => {
  const brand = siteSettings['site.brand'].schema;
  expect(['', 'feddit'].map((value) => brand.allows(value))).toEqual([true, true]);
  expect(brand.allows('other')).toBe(false);
  const width = siteSettings['site.width'].schema;
  expect(['narrow', 'default', 'wide', 'full'].map((value) => width.allows(value))).toEqual([true, true, true, false]);
});

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
