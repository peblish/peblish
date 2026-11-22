import type { Prefs } from '@peblish/core/prefs/cookie';
import type { SiteBrand } from '@peblish/schema/site-settings';
import { brandPack } from '@peblish/ui/brand/packs.ts';
import fedditSheet from '@peblish/ui/brand/feddit/pack.css?url';
import fedditIcon32 from '@peblish/ui/brand/feddit/icon-32.png?url&no-inline';
import fedditIcon from '@peblish/ui/brand/feddit/icon.svg?url&no-inline';
import fedditTouchIcon from '@peblish/ui/brand/feddit/touch-icon.png?url&no-inline';

// Each pack's files as the app serves them (packages/ui/src/brand/pack.ts describes a pack). The icons stay
// files: below Vite's inline limit they would otherwise ride in the root route's script as data URLs.
const files = {
  feddit: { sheet: fedditSheet, icon: fedditIcon, icon32: fedditIcon32, touchIcon: fedditTouchIcon },
} satisfies Record<Exclude<SiteBrand, ''>, Record<string, string>>;

/**
 * The browser's theme colour under the site's brand pack: the chosen scheme's, or both by media query when
 * the page follows the system's. None without a pack.
 */
export function brandMeta(brand: SiteBrand, scheme: Prefs['scheme']): { name: string; content: string; media?: string }[] {
  const pack = brandPack(brand);
  if (!pack) return [];
  const { light, dark } = pack.themeColour;
  if (scheme !== 'system') return [{ name: 'theme-color', content: scheme === 'light' ? light : dark }];
  return [
    { name: 'theme-color', content: light, media: '(prefers-color-scheme: light)' },
    { name: 'theme-color', content: dark, media: '(prefers-color-scheme: dark)' },
  ];
}

/** The root head's links for the site's brand pack (`site.brand`): its sheet after the app's, and its icons. None without one. */
export function brandLinks(brand: SiteBrand) {
  if (brand === '') return [];
  const { sheet, icon, icon32, touchIcon } = files[brand];
  return [
    { rel: 'stylesheet', href: sheet, id: 'pb-brand-css' },
    { rel: 'icon', href: icon, type: 'image/svg+xml' },
    { rel: 'icon', href: icon32, type: 'image/png', sizes: '32x32' },
    { rel: 'apple-touch-icon', href: touchIcon },
  ];
}
