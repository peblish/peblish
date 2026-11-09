// Locale negotiation, kept free of server imports so it is unit-tested directly.

/** The locales the UI ships; a new one joins here and in every i18n catalogue. */
export const SUPPORTED_LOCALES = ['en-US', 'de-DE'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en-US';

type Range = { tag: string; quality: number; index: number };

const languageOf = (tag: string) => tag.split('-')[0];

/** Accept-Language ranges, lowercased, with their q values (parameter names are case-insensitive). */
function parse(header: string): Range[] {
  return header.split(',').flatMap((part, index) => {
    const [tag = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    const q = params.find((param) => param.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    return tag && Number.isFinite(quality) ? [{ tag, quality, index }] : [];
  });
}

/** How specifically `range` names `locale`: 3 exactly, 2 as its language, 1 as a sibling region, 0 as `*`, -1 not at all. */
function specificity(range: string, locale: string): number {
  const lower = locale.toLowerCase();
  if (range === lower) return 3;
  if (range === '*') return 0;
  if (lower.startsWith(`${range}-`)) return 2;
  return languageOf(range) === languageOf(lower) ? 1 : -1;
}

/**
 * The supported locale an Accept-Language header prefers. Each supported locale takes the q
 * of the most specific range that names it, so an explicit `de-DE;q=0` excludes de-DE even
 * when `de` or `*` would allow it; a sibling region counts ("de-AT" names de-DE). The highest
 * q above 0 wins, ties going to the range that comes first in the header. No match, or no
 * header, is en-US. Only the result reaches <html lang> and Intl, so the server and the
 * browser format with the same locale.
 */
export function negotiateLocale(header: string | null | undefined): SupportedLocale {
  const ranges = parse(header ?? '');
  let best: Range & { locale: SupportedLocale } = { locale: DEFAULT_LOCALE, tag: '', quality: 0, index: Infinity };
  for (const locale of SUPPORTED_LOCALES) {
    let match: (Range & { specificity: number }) | undefined;
    for (const range of ranges) {
      const level = specificity(range.tag, locale);
      if (level >= 0 && (!match || level > match.specificity)) match = { ...range, specificity: level };
    }
    if (match && match.quality > 0 && (match.quality > best.quality || (match.quality === best.quality && match.index < best.index))) {
      best = { ...match, locale };
    }
  }
  return best.locale;
}
