import { type } from 'arktype';

// The site banner: the site setting `site.banner` (site-settings.ts), one message an admin
// publishes across the top of every page. Every field is always present; only the shapes
// live here, and the admin form, the contrast check of a custom colour and the shell's slot
// come with the banner feature.

export const bannerIcons = ['none', 'info', 'megaphone', 'wrench', 'calendar', 'alert', 'sparkles'] as const;
export const bannerTones = ['neutral', 'accent', 'success', 'warning', 'danger', 'custom'] as const;

/**
 * A path on this site: one leading slash, and no second slash or backslash right after it,
 * which browsers read as another host (`//host`, `/\host`). No whitespace or backslash anywhere.
 */
export const InternalPath = type(/^\/(?![/\\])[^\s\\]*$/);

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
