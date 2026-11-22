const zwj = 0x200d;
const mark = /^\p{M}$/u;

/** A code point that belongs to the one before it: a combining mark (variation selectors and the keycap among them), a skin tone, a tag. */
const extending = (point: string) => {
  const code = point.codePointAt(0)!;
  return mark.test(point) || (code >= 0x1f3fb && code <= 0x1f3ff) || (code >= 0xe0020 && code <= 0xe007f);
};
const regional = (point: string | undefined) => {
  const code = point?.codePointAt(0) ?? 0;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
};

/** A UTF-16 unit with no partner: in a `u` pattern only an unpaired surrogate is a code point of its own. */
const lone = /\p{Cs}/gu;

/**
 * What an avatar without a picture shows: the name's first character as a reader sees it, upper-cased, so an
 * emoji, a flag, a skin tone, a family joined by zero-width joiners or a letter with its combining marks stays
 * whole. The rule is this file's own (a regional indicator pair, then marks, modifiers, tags and joined code
 * points), not Intl.Segmenter's, which some browsers lack. The name is composed first (NFC), so a Hangul
 * syllable sent as its separate letters stays one syllable, and a lone surrogate comes back as U+FFFD.
 *
 * Run it on the server only, where a page's data is built, and send the result as a field: which marks a
 * runtime knows depends on its Unicode version (U+0897 is newer than some browsers), so a browser that worked
 * it out again could disagree with the server's page and fail to hydrate. `fallback` stands for a name that is
 * empty or only spaces.
 */
export function avatarInitial(name: string, fallback: string): string {
  const points = [...name.normalize('NFC').trim()];
  if (points.length === 0) return fallback;
  let end = regional(points[0]) && regional(points[1]) ? 2 : 1;
  while (end < points.length) {
    const point = points[end]!;
    if (extending(point)) end += 1;
    else if (point.codePointAt(0) === zwj && end + 1 < points.length) end += 2;
    else break;
  }
  return points.slice(0, end).join('').toUpperCase().replace(lone, '\uFFFD');
}
