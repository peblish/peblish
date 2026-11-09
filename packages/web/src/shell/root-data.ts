import { parsePrefs } from '@peblish/core/prefs/cookie';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server';
import { negotiateLocale } from '../i18n/negotiate.ts';
import { pageSession } from '../server/auth.ts';
import { loadShellData } from './data.ts';

/**
 * Everything the shell needs for a page, in one call so a client-side navigation costs one
 * request: the negotiated locale (it depends on Accept-Language, and the response says so),
 * the display preferences from the cookie, the signed-in person (null when signed out) and the
 * sidebar's lists. Reading the session marks the response `private, no-store`, which every
 * page needs now that the shell names the viewer.
 *
 * It does the work of lane A's getSessionView() itself: a server function called from inside
 * another is missing from the production build's function table.
 */
export const getRootData = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('vary', 'Accept-Language');
  const session = await pageSession();
  return {
    locale: negotiateLocale(getRequestHeader('accept-language')),
    prefs: parsePrefs(getRequestHeader('cookie')),
    session: session?.view ?? null,
    shell: await loadShellData(session?.view ?? null),
  };
});
