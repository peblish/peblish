import { expect, test } from 'vitest';
import { avatarInitial } from './avatar-initial.ts';

// Escapes only, so the zero-width joiners and the combining mark are visible here.
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';

test("an avatar's initial is the name's first grapheme, upper-cased, never part of one", () => {
  expect(avatarInitial('\u{1F33F} Fern', '?')).toBe('\u{1F33F}');
  expect(avatarInitial('\u{1F1E6}\u{1F1FA} Mate', '?')).toBe('\u{1F1E6}\u{1F1FA}');
  expect(avatarInitial(`${family} Hollis`, '?')).toBe(family);
  expect(avatarInitial('élodie', '?')).toBe('É');
  expect(avatarInitial('élodie', '?')).toBe('É');
});

test('an empty name, or one of spaces, gets the caller’s fallback', () => {
  expect(avatarInitial('', '?')).toBe('?');
  expect(avatarInitial('   ', '?')).toBe('?');
  expect(avatarInitial(' ', '')).toBe('');
});
