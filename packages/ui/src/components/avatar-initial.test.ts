import { afterEach, expect, test, vi } from 'vitest';

// Escapes only, so the joiners, the modifiers and the combining marks are visible here.
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const astronaut = '\u{1F9D1}\u{1F3FF}‍\u{1F680}';
const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
const shin = 'שָׁ';

/** Each name and the initial an avatar shows for it: one whole character, never part of one, composed (NFC). */
const cases: [string, string][] = [
  ['\u{1F1E6}\u{1F1FA} Mate', '\u{1F1E6}\u{1F1FA}'],
  [`${england} Hollis`, england],
  [`${family} Hollis`, family],
  ['\u{1F44B}\u{1F3FD} Wave', '\u{1F44B}\u{1F3FD}'],
  [`${astronaut} Orbit`, astronaut],
  ['❤️ Heart', '❤️'],
  // A letter and its combining accent come composed (NFC): one code point, as the server sends it.
  ['e\u0301lodie', '\u00C9'],
  // NFC puts the vowel before the shin dot; the initial is still the letter with both.
  [`${shin}לוֹם`, shin.normalize('NFC')],
  ['\u{1F33F} Fern', '\u{1F33F}'],
  ['fern', 'F'],
  ['  wren', 'W'],
];

/** The helper as a page loads it, with Intl as it is when the module is read. */
async function helper() {
  vi.resetModules();
  return (await import('./avatar-initial.ts')).avatarInitial;
}

const segmenter = Intl.Segmenter;
afterEach(() => {
  Object.defineProperty(Intl, 'Segmenter', { value: segmenter, writable: true, configurable: true });
});

test('without Intl.Segmenter the helper loads, and an initial is the name’s whole first character', async () => {
  Reflect.deleteProperty(Intl, 'Segmenter');
  expect(Intl.Segmenter).toBeUndefined();
  const avatarInitial = await helper();
  for (const [name, initial] of cases) expect(avatarInitial(name, '?'), name).toBe(initial);
  expect(avatarInitial('', '?')).toBe('?');
  expect(avatarInitial('   ', '?')).toBe('?');
});

test('with Intl.Segmenter the initials are the same, and are the first grapheme it finds', async () => {
  const avatarInitial = await helper();
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const [name, initial] of cases) {
    expect(avatarInitial(name, '?'), name).toBe(initial);
    expect([...graphemes.segment(name.normalize('NFC').trim())][0]!.segment.toUpperCase(), name).toBe(initial);
  }
  expect(avatarInitial('', '?')).toBe('?');
  expect(avatarInitial('   ', '')).toBe('');
});

test('a decomposed Hangul syllable keeps its vowel and final consonant, U+0897 stays on its letter, and a lone surrogate is replaced', async () => {
  const avatarInitial = await helper();
  // ㄱ, ㅏ and ㄱ as three letters (U+1100 U+1161 U+11A8) compose to the one syllable 각 (U+AC01).
  expect(avatarInitial('각 Jun', '?')).toBe('각');
  // This runtime's Unicode data knows U+0897 as a combining mark; older browsers' does not, so only the server works it out.
  expect(avatarInitial('aࢗ Pepet', '?')).toBe('Aࢗ');
  expect(avatarInitial('\uD83D Fern', '?')).toBe('�');
  expect(avatarInitial('\uDF3F', '?')).toBe('�');
});
