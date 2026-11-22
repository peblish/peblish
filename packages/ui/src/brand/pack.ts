/**
 * A brand pack: an instance's look, checked in as one folder under packages/ui/src/brand/ and chosen by
 * the site setting `site.brand`. The folder holds:
 *
 * - `pack.css`, the token override sheet: Mux reference tokens on `:root` (so semantic and dark values
 *   follow), Mux tokens set to tokens, the wordmark's `--pb-brand-wordmark-font` and
 *   `--pb-brand-wordmark-weight`, and the wordmark's `@font-face`, nothing else (the guard's
 *   css-brand-pack rule);
 * - `pack.ts`, this shape: the wordmark's text and the mark;
 * - the wordmark's font file, if the pack has one: a slice holding the wordmark's letters, renamed when
 *   its licence reserves the font's name, with that licence;
 * - `icon.svg`, `icon-32.png` and `touch-icon.png`, drawn from the mark, which the root route links
 *   (packages/web/src/shell/brand-head.ts).
 *
 * With no pack, the shell shows the site's name as text and Mux UI's own palette, as before packs.
 */
export type BrandPack = {
  /** The name beside the mark in the desktop header, in the pack's wordmark face. Hidden from assistive technology: the link is named by the site name. */
  wordmark: string;
  /** One path, filled with the text colour around it, no tile. */
  mark: { viewBox: string; d: string; transform?: string };
  /** The browser's theme colour (its bar on phones) in each scheme: the phone bar's background under the pack. */
  themeColour: { light: string; dark: string };
};
