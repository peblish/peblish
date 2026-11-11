// Attributes for <html>. Mux UI reads its scheme from data-muxui-color-scheme (light or dark);
// data-scheme says what the person chose, including 'system'. themes.css (the preset themes) is
// not offered, so there is no data-muxui-theme.

export const schemes = ['system', 'light', 'dark'] as const;
/** What the person chose; 'system' follows the operating system. */
export type Scheme = (typeof schemes)[number];

/** A choice as the display cookie may hold it: 'black' (true black, no longer offered) is still accepted. */
export type StoredScheme = Scheme | 'black';

/** The choice a stored value stands for: a stored true black is Mux UI's dark scheme. */
export const toScheme = (stored: StoredScheme): Scheme => (stored === 'black' ? 'dark' : stored);

/** The Mux scheme a choice renders with; 'system' is light until the inline script or an effect applies the OS setting. */
export function muxScheme(scheme: Scheme): 'light' | 'dark' {
  return scheme === 'dark' ? 'dark' : 'light';
}

export function rootThemeAttributes(stored: StoredScheme) {
  const scheme = toScheme(stored);
  return { 'data-muxui-color-scheme': muxScheme(scheme), 'data-scheme': scheme } as const;
}

/**
 * Runs in <head> before first paint, only when the choice is 'system': a visitor whose OS is
 * dark gets the dark scheme from the first frame instead of a light flash. The server cannot
 * know the OS setting, so this is the one thing it leaves to the browser.
 */
export const systemSchemeScript = `if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-muxui-color-scheme','dark')`;

/** Applies a choice to <html> from the client, including 'system' (the OS setting at this moment). */
export function applyScheme(scheme: Scheme): void {
  const root = document.documentElement;
  const dark = scheme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : muxScheme(scheme) === 'dark';
  root.setAttribute('data-muxui-color-scheme', dark ? 'dark' : 'light');
  root.setAttribute('data-scheme', scheme);
}
