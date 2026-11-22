import { Banner, Link, type BannerTone } from '@muxui/react';
import type { SiteBanner as SiteBannerSetting } from '@peblish/schema/banner';
import type { ComponentType } from 'react';
import { ButtonLink } from './button-link.tsx';
import { AlertIcon, CalendarIcon, InfoIcon, MegaphoneIcon, SparklesIcon, WrenchIcon } from './icons.tsx';

// The site banner (Commons): the `site.banner` setting drawn with Mux UI's Banner. The shell shows the
// published one across the top of every page; the admin form shows its draft as a preview.

/** The setting's fields the banner draws: everything but `revision` and `enabled`, which say whether and when. */
export type SiteBannerContent = Omit<SiteBannerSetting, 'revision' | 'enabled'>;

const glyphs: Record<Exclude<SiteBannerContent['icon'], 'none'>, ComponentType> = {
  info: InfoIcon,
  megaphone: MegaphoneIcon,
  wrench: WrenchIcon,
  calendar: CalendarIcon,
  alert: AlertIcon,
  sparkles: SparklesIcon,
};

/**
 * The setting's tone as Mux's: its Accent is Mux's brand, and Custom is the colour itself (`customColor`),
 * which Mux reads with black or white text, whichever contrasts more. A colour Mux cannot read, or one that is
 * not opaque, falls back to the tone given here, Neutral.
 */
export function muxTone(content: Pick<SiteBannerContent, 'tone' | 'colour'>): { tone: BannerTone; customColor?: string } {
  if (content.tone === 'custom') return { tone: 'neutral', customColor: content.colour };
  return { tone: content.tone === 'accent' ? 'brand' : content.tone };
}

export interface SiteBannerProps {
  /** What to draw. Title, message and labels are plain text. */
  banner: SiteBannerContent;
  /** The region's name ("Site notice"). */
  label: string;
  dismissLabel: string;
  /** Called by the dismiss button, which shows when the banner is dismissible. With scripts off it is hidden. */
  onDismiss?: () => void;
  className?: string;
}

/** A published banner, or a preview of one. It never hides itself: whoever shows it stops rendering it once dismissed. */
export function SiteBanner({ banner, label, dismissLabel, onDismiss, className }: SiteBannerProps) {
  const Glyph = banner.icon === 'none' ? null : glyphs[banner.icon];
  const { primary, link } = banner;
  return (
    <Banner
      className={className ? `pb-banner ${className}` : 'pb-banner'}
      label={label}
      title={banner.title || undefined}
      icon={Glyph ? <Glyph /> : undefined}
      {...muxTone(banner)}
      emphasis={banner.emphasis}
      align={banner.align}
      dismissible={banner.dismissible}
      dismissed={false}
      onDismiss={onDismiss}
      dismissLabel={dismissLabel}
    >
      {banner.message}
      {/* Mux's Banner actions are buttons with a callback, so the button action would be dead with scripts off and
          no ordinary link with them on. Both actions are real links here (the button one the facade's ButtonLink),
          after the message, in a group with Mux's own actions class: Mux's banner recipe draws them (the filled
          button, the link in the banner's colours) as it draws its own. site-banner.css places the group. */}
      {primary || link ? (
        <span className="muxui-banner__actions pb-banner__actions">
          {primary ? (
            <ButtonLink href={primary.href} variant="neutral" size="sm" className="muxui-banner__action">
              {primary.label}
            </ButtonLink>
          ) : null}
          {link ? (
            <Link className="muxui-banner__link" href={link.href}>
              {link.label}
            </Link>
          ) : null}
        </span>
      ) : null}
    </Banner>
  );
}
