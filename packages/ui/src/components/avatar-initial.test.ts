import { afterEach, expect, test, vi } from 'vitest';

// Escapes only, so the joiners, the modifiers and the combining marks are visible here.
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const astronaut = '\u{1F9D1}\u{1F3FF}‍\u{1F680}';
const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
const shin = 'שָׁ';

/** Each name and the initial an avatar shows for it: one whole character, never part of one. */
const cases: [string, string][] = [
  ['\u{1F1E6}\u{1F1FA} Mate', '\u{1F1E6}\u{1F1FA}'],
  [`${england} Hollis`, england],
  [`${family} Hollis`, family],
  ['\u{1F44B}\u{1F3FD} Wave', '\u{1F44B}\u{1F3FD}'],
  [`${astronaut} Orbit`, astronaut],
  ['❤️ Heart', '❤️'],
  ['élodie', 'É'],
  [`${shin}לוֹם`, shin],
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
    expect([...graphemes.segment(name.trim())][0]!.segment.toUpperCase(), name).toBe(initial);
  }
  expect(avatarInitial('', '?')).toBe('?');
  expect(avatarInitial('   ', '')).toBe('');
});
