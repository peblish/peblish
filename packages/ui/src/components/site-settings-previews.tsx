import { SiteBanner, type SiteBannerContent } from './site-banner.tsx';

// The admin form's previews of the site banner and the layout width (Commons). Pictures only: nothing in
// them can be focused or pressed, and the width's is hidden from assistive technology, since its radio
// labels already say the sizes.

export interface BannerPreviewsProps {
  banner: SiteBannerContent;
  /** Each frame's caption and its banner's region name. */
  labels: Record<'light' | 'dark', { caption: string; region: string }>;
  dismissLabel: string;
}

/**
 * The banner as it will look, once in each scheme: each frame draws Mux's own scheme (its colour-scheme
 * scope) on the page's ground, so a custom colour shows what both themes will make of it, and changes at
 * once as the draft does (its reduced-motion scope).
 */
export function BannerPreviews({ banner, labels, dismissLabel }: BannerPreviewsProps) {
  return (
    <div className="pb-banner-previews">
      {(['light', 'dark'] as const).map((scheme) => (
        // Mux's motion scope too: a preview changes at once, never through a colour transition.
        <figure key={scheme} className="pb-banner-preview" data-muxui-color-scheme={scheme} data-muxui-motion="reduced">
          <figcaption className="pb-banner-preview__caption">{labels[scheme].caption}</figcaption>
          <div inert>
            <SiteBanner banner={banner} label={labels[scheme].region} dismissLabel={dismissLabel} />
          </div>
        </figure>
      ))}
    </div>
  );
}

/** The three presets' centre widths, in rem, beside the rail's 19.5rem (shell.css). */
const centres = { narrow: 35, default: 40, wide: 50 } as const;
const rail = 19.5;

/** The centre and the rail at a preset, to scale against Wide, the widest. */
export function WidthPreview({ width }: { width: keyof typeof centres }) {
  return (
    <div className="pb-width-preview" aria-hidden="true">
      <div className="pb-width-preview__page" style={{ inlineSize: `${((centres[width] + rail) / (centres.wide + rail)) * 100}%` }}>
        <span className="pb-width-preview__centre" style={{ flexGrow: centres[width] }} />
        <span className="pb-width-preview__rail" style={{ flexGrow: rail }} />
      </div>
    </div>
  );
}
