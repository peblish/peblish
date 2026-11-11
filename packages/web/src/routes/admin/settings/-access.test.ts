import { expect, test } from 'vitest';
import { translate } from '../../../i18n/translate.ts';
import { accessOf } from './-access.ts';

test('an admin whose session skipped two-factor is told to sign in again with a code, not to turn it on (review 2 AN3)', () => {
  const admin = (siteRole: 'user' | 'admin', twoFactorEnabled: boolean): Parameters<typeof accessOf>[0] => ({
    role: 'admin',
    view: { siteRole, twoFactorEnabled },
  });
  expect(accessOf(admin('admin', true))).toBe('ok');
  expect(accessOf(admin('user', false))).toBe('needs-two-factor');
  expect(accessOf(admin('user', true))).toBe('needs-two-factor-sign-in');
  expect(accessOf({ role: 'user', view: { siteRole: 'user', twoFactorEnabled: true } })).toBe('not-admin');
  expect(translate('en', 'admin', 'access.signInWithTwoFactor')).toBe('Sign in again with a two-factor code to use this page.');
});
