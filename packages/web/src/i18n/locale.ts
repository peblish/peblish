import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

export const DEFAULT_LOCALE = 'en-US';

/** The first Accept-Language tag Intl accepts, ignoring q-values, else en-US. */
export function pickLocale(header: string | undefined): string {
  for (const part of (header ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim();
    if (!tag || tag === '*') continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      if (canonical) return canonical;
    } catch {
      // An invalid tag falls through to the next entry.
    }
  }
  return DEFAULT_LOCALE;
}

/** Runs on the server for the document request; the result is dehydrated into the page. */
export const getRequestLocale = createServerFn({ method: 'GET' }).handler(() => pickLocale(getRequestHeader('accept-language')));
