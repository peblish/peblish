import { safeRedirect } from '../../server/auth.ts';

/**
 * Where the report pages' Cancel and Done links and the form's redirects go: `back` as a path on
 * this site, else '/'. Server only (the loaders' server functions and the POST handler), through
 * safeRedirect: browsers drop tabs and line breaks from a URL, so `/\t/evil.example` must not
 * reach an href, where it would become `//evil.example`.
 */
export const reportBack = (back: string | undefined, origin: string): string => safeRedirect(back, origin);
