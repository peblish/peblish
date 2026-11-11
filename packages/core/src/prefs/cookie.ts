import { type } from 'arktype';

// Display preferences for the MVP live in one cookie, so a request renders the chosen density
// and colour scheme on the server with no flash. A per-account copy would need an authz
// action and an event type; it is not built.

const Density = type("'card' | 'classic' | 'compact'");
const Scheme = type("'system' | 'light' | 'dark' | 'black'");

/** The feed density and the colour scheme ('black' is an old cookie's value: the choice is gone and it renders as dark). */
export const Prefs = type({ density: Density, scheme: Scheme });
export type Prefs = typeof Prefs.infer;

export const defaultPrefs: Prefs = { density: 'classic', scheme: 'system' };

export const prefsCookieName = 'peblish_prefs';

const oneYear = 365 * 24 * 60 * 60;

/** The cookie's value, read from a Cookie header; a missing cookie or a bad field falls back to its default. */
export function parsePrefs(cookieHeader: string | null | undefined): Prefs {
  const raw = cookieHeader
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${prefsCookieName}=`))
    ?.slice(prefsCookieName.length + 1);
  // The value is a query string (density=card&scheme=black); it is never URL-decoded further than that.
  const fields = new URLSearchParams(raw ?? '');
  const density = Density(fields.get('density'));
  const scheme = Scheme(fields.get('scheme'));
  return {
    density: density instanceof type.errors ? defaultPrefs.density : density,
    scheme: scheme instanceof type.errors ? defaultPrefs.scheme : scheme,
  };
}

/** A Set-Cookie value that stores `prefs` for a year. HttpOnly: only the server reads it. */
export function prefsSetCookie(prefs: Prefs, { secure }: { secure: boolean }): string {
  const value = new URLSearchParams({ density: prefs.density, scheme: prefs.scheme }).toString();
  return `${prefsCookieName}=${value}; Path=/; Max-Age=${oneYear}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
}
