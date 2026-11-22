import { type } from 'arktype';

// The site banner: the site setting `site.banner` (site-settings.ts), one message an admin
// publishes across the top of every page. Every field is always present; only the shapes
// live here, and the admin form, the contrast check of a custom colour and the shell's slot
// come with the banner feature.

export const bannerIcons = ['none', 'info', 'megaphone', 'wrench', 'calendar', 'alert', 'sparkles'] as const;
export const bannerTones = ['neutral', 'accent', 'success', 'warning', 'danger', 'custom'] as const;

/**
 * A path on this site: one leading slash, and no second slash or backslash right after it,
 * which browsers read as another host (`//host`, `/\host`). No whitespace, backslash or control
 * character anywhere (C0, DEL and C1), nor one percent-encoded (`%00` to `%1F`, `%7F`, a lone `%80`
 * to `%9F`, and C1 as UTF-8, `%C2%80` to `%C2%9F`; a `%80` inside another UTF-8 sequence is no control).
 */
export const InternalPath = type(
  // oxlint-disable-next-line no-control-regex -- the controls are what it refuses
  /^\/(?![/\\])(?!.*(?:%[01][0-9a-f]|%7f|(?<!%[0-9a-f]{2})%[89][0-9a-f]|%c2%[89][0-9a-f]))[^\s\\\x00-\x1f\x7f-\x9f]*$/i,
);

/** A banner button (`primary`) or link (`link`): a short label and where it goes on this site. */
export const BannerAction = type({ '+': 'reject', label: '1 <= string <= 16', href: InternalPath });
export type BannerAction = typeof BannerAction.infer;

export const SiteBanner = type({
  '+': 'reject',
  enabled: 'boolean',
  /** Raised by the server on every publish; a browser's dismissal is keyed by it, so a new banner shows again. */
  revision: 'number.integer >= 0',
  /** May be empty. */
  title: 'string <= 32',
  message: 'string <= 140',
  icon: type.enumerated(...bannerIcons),
  tone: type.enumerated(...bannerTones),
  /** Used when `tone` is 'custom'; checked for contrast in both schemes before it is saved. */
  colour: /^#[0-9a-fA-F]{6}$/,
  emphasis: "'subtle' | 'solid'",
  align: "'start' | 'center'",
  dismissible: 'boolean',
  /** Shown as a button. */
  primary: BannerAction.or('null'),
  /** Shown as a link. */
  link: BannerAction.or('null'),
});
export type SiteBanner = typeof SiteBanner.infer;

/** What an admin publishes: the banner without `revision`, which the server raises. */
export const BannerPublish = SiteBanner.omit('revision');
export type BannerPublish = typeof BannerPublish.infer;

/** No banner: the setting's value until an admin publishes one. */
export const defaultBanner: SiteBanner = {
  enabled: false,
  revision: 0,
  title: '',
  message: '',
  icon: 'none',
  tone: 'neutral',
  colour: '#007ba7',
  emphasis: 'subtle',
  align: 'center',
  dismissible: true,
  primary: null,
  link: null,
};

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * How a custom colour reads as a banner, by Mux UI's Banner rule: the solid fill is the colour itself in both
 * schemes, its text, link, controls and their focus ring are white or black, whichever contrasts more, and a
 * subtle banner lays at most a quarter of the colour over the page under the page's own text. So the lowest
 * ratio is the solid fill's against its text: the WCAG 2 ratio returned here, which must reach 4.5 (text; the
 * focus ring, 3, then holds too). Null for a colour that is not #RRGGBB.
 */
export function customBannerContrast(colour: string): number | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!hex) return null;
  const [r, g, b] = hex.slice(1).map((part) => channel(Number.parseInt(part, 16)));
  const fill = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return Math.max(1.05 / (fill + 0.05), (fill + 0.05) / 0.05);
}

/** The ratio a custom banner colour must reach in both schemes, for text; its focus ring needs 3. */
export const customBannerMinimum = 4.5;
