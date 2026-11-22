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

/**
 * What an avatar without a picture shows: the name's first character as a reader sees it, upper-cased, so an
 * emoji, a flag, a skin tone, a family joined by zero-width joiners or a letter with its combining marks stays
 * whole. Half of one (a single UTF-16 unit) reaches the browser as a replacement character from the server and
 * as a lone surrogate from the client, and the two would not hydrate. The rule is this file's own (a regional
 * indicator pair, then marks, modifiers, tags and joined code points), not Intl.Segmenter's, which some
 * browsers lack: the server and every browser take the same character. `fallback` stands for a name that is
 * empty or only spaces.
 */
export function avatarInitial(name: string, fallback: string): string {
  const points = [...name.trim()];
  if (points.length === 0) return fallback;
  let end = regional(points[0]) && regional(points[1]) ? 2 : 1;
  while (end < points.length) {
    const point = points[end]!;
    if (extending(point)) end += 1;
    else if (point.codePointAt(0) === zwj && end + 1 < points.length) end += 2;
    else break;
  }
  return points.slice(0, end).join('').toUpperCase();
}
