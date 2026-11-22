const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * What an avatar without a picture shows: the name's first grapheme, upper-cased, so an emoji, a flag, a
 * family joined by zero-width joiners or a letter with a combining mark stays whole. Half of one (a single
 * UTF-16 unit) would reach the browser as a replacement character from the server and as a lone surrogate
 * from the client, and the two would not hydrate. `fallback` stands for a name that is empty or only spaces.
 */
export function avatarInitial(name: string, fallback: string): string {
  const [first] = graphemes.segment(name.trim());
  return first ? first.segment.toUpperCase() : fallback;
}
