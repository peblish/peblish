import { plainModule } from '@peblish/ui/__fixtures__/plain-module.ts';
import { LocaleProvider } from '@peblish/ui/locale';
import { expect, test } from 'vitest';

// ui's exports map: .tsx modules are imported without an extension, .ts modules with it.
test('web resolves both .tsx and .ts modules from ui', () => {
  expect(typeof LocaleProvider).toBe('function');
  expect(plainModule).toBe('resolved from a .ts file');
});
