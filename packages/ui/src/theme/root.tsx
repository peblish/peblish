// Attributes for <html>. Mux UI reads its scheme from data-muxui-color-scheme (light or dark);
// peblish adds a third, true black (#000), as data-scheme="black" on top of the dark scheme.
// themes.css (the preset themes) is not offered, so there is no data-muxui-theme.

export const schemes = ['system', 'light', 'dark', 'black'] as const;
/** What the person chose; 'system' follows the operating system. */
export type Scheme = (typeof schemes)[number];

/** The Mux scheme a choice renders with; 'system' is light until the inline script or an effect applies the OS setting. */
export function muxScheme(scheme: Scheme): 'light' | 'dark' {
  return scheme === 'dark' || scheme === 'black' ? 'dark' : 'light';
}

export function rootThemeAttributes(scheme: Scheme) {
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
