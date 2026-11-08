// Locale negotiation, kept free of server imports so it is unit-tested directly.

/** The locales the UI ships; a new one joins here and in every i18n catalogue. */
export const SUPPORTED_LOCALES = ['en-US', 'de-DE'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en-US';

const languageOf = (tag: string) => tag.split('-')[0]?.toLowerCase();

/**
 * The supported locale an Accept-Language header prefers: ranges by q value (q=0 means "not
 * this one"; ties keep header order), each matching a supported locale exactly or by its
 * language ("de-AT" is de-DE). `*`, no match or no header is en-US. Only the result reaches
 * <html lang> and Intl, so the server and the browser format with the same locale.
 */
export function negotiateLocale(header: string | null | undefined): SupportedLocale {
  const ranges = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';').map((piece) => piece.trim());
      const q = params.find((param) => param.startsWith('q='));
      return { tag: tag.toLowerCase(), quality: q ? Number(q.slice(2)) : 1, index };
    })
    .filter(({ tag, quality }) => tag && quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranges) {
    if (tag === '*') return DEFAULT_LOCALE;
    const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const sameLanguage = SUPPORTED_LOCALES.find((locale) => languageOf(locale) === languageOf(tag));
    if (sameLanguage) return sameLanguage;
  }
  return DEFAULT_LOCALE;
}
