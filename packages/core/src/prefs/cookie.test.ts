import { expect, test } from 'vitest';
import { defaultPrefs, parsePrefs, prefsSetCookie } from './cookie.ts';

test('a missing cookie reads as the defaults', () => {
  expect(parsePrefs(undefined)).toEqual(defaultPrefs);
  expect(parsePrefs('a=1; b=2')).toEqual(defaultPrefs);
});

test('a stored choice survives the round trip through Set-Cookie', () => {
  const stored = prefsSetCookie({ density: 'compact', scheme: 'black' }, { secure: true });
  const [pair, ...attributes] = stored.split('; ');
  expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']));
  expect(parsePrefs(`theme=x; ${pair}; other=y`)).toEqual({ density: 'compact', scheme: 'black' });
});

test('an invalid field falls back alone, whatever else is in the cookie', () => {
  expect(parsePrefs('peblish_prefs=density=card&scheme=neon')).toEqual({ density: 'card', scheme: 'system' });
  expect(parsePrefs('peblish_prefs=density=%00&scheme=dark')).toEqual({ density: 'classic', scheme: 'dark' });
  expect(parsePrefs('peblish_prefs=density=card&density=compact&scheme=light').density).toBe('card');
  expect(parsePrefs('peblish_prefs=')).toEqual(defaultPrefs);
});

test('Secure is left off only when asked', () => {
  expect(prefsSetCookie(defaultPrefs, { secure: false })).not.toContain('Secure');
});
