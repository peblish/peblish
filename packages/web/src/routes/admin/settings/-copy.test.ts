import { killSwitches } from '@peblish/schema/site-settings';
import { expect, test } from 'vitest';
import admin from '../../../i18n/admin.json' with { type: 'json' };

test('the admin catalogue has the same keys in en and de, and no empty text', () => {
  expect(Object.keys(admin.de).sort()).toEqual(Object.keys(admin.en).sort());
  for (const language of [admin.en, admin.de]) for (const [key, text] of Object.entries(language)) expect(text, key).not.toBe('');
});

test('every kill switch has its label, help, on, off, pause and resume copy in en and de', () => {
  for (const language of [admin.en, admin.de] as Record<string, string>[])
    for (const key of killSwitches)
      for (const part of ['label', 'help', 'on', 'off', 'pause', 'resume'])
        expect(language[`settings.switch.${key}.${part}`], `${key} ${part}`).toBeTruthy();
});
