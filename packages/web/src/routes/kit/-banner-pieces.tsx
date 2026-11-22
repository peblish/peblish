import { bannerTones, defaultBanner } from '@peblish/schema/banner';
import { SiteBanner, type SiteBannerContent } from '@peblish/ui/components/site-banner';
import { BannerPreviews, WidthPreview } from '@peblish/ui/components/site-settings-previews';
import { useTranslate } from '../../i18n/use-translate.ts';
import type { Composition } from './-states.tsx';

// The site banner's and the width setting's state pages (/kit/<key>), registered in -states.tsx (banner and
// width lane). Each banner page puts the control the state helper drives first: the button, else the link,
// else the dismiss button. Sample content is invented.

const full: SiteBannerContent = {
  ...defaultBanner,
  title: 'Read-only window',
  message: 'Posting pauses for an hour on Sunday while the database moves. Reading works.',
  icon: 'wrench',
  tone: 'accent',
  primary: { label: 'Details', href: '/kit/site-banner#details' },
  link: { label: 'Rules', href: '/kit/site-banner#rules' },
  dismissible: true,
};

function Sample({ banner }: { banner: Partial<SiteBannerContent> }) {
  const { t } = useTranslate();
  return (
    <SiteBanner
      banner={{ ...full, ...banner }}
      label={t('shell', 'banner.label')}
      dismissLabel={t('shell', 'banner.dismiss')}
      onNavigate={() => undefined}
      onDismiss={() => undefined}
    />
  );
}

/** Every tone in both emphases, with a title and every control, then without a title: for the contrast spec. */
function AllTones() {
  return (
    <div className="kit-stack">
      {(['subtle', 'solid'] as const).flatMap((emphasis) =>
        bannerTones.map((tone) => (
          <div key={`${tone}-${emphasis}`} data-kit-banner={`${tone}-${emphasis}`}>
            <Sample banner={{ tone, emphasis, colour: '#6e4bd8', title: tone === 'neutral' ? '' : full.title }} />
          </div>
        )),
      )}
    </div>
  );
}

function Previews() {
  const { t } = useTranslate();
  return (
    <BannerPreviews
      banner={{ ...full, tone: 'custom', colour: '#d6409f', emphasis: 'solid' }}
      labels={{
        light: { caption: t('admin', 'settings.banner.preview.light'), region: t('admin', 'settings.banner.preview.region.light') },
        dark: { caption: t('admin', 'settings.banner.preview.dark'), region: t('admin', 'settings.banner.preview.region.dark') },
      }}
      dismissLabel={t('shell', 'banner.dismiss')}
    />
  );
}

export const bannerPieces: Readonly<Record<string, Composition>> = {
  'site-banner': { name: 'Site banner, subtle', states: { rest: () => <Sample banner={{}} /> } },
  'site-banner-solid': { name: 'Site banner, solid', states: { rest: () => <Sample banner={{ emphasis: 'solid' }} /> } },
  // A colour neither black nor white reads well on, and one that is not opaque, which falls back to the tone.
  'site-banner-custom': {
    name: 'Site banner, custom colour',
    states: { rest: () => <Sample banner={{ tone: 'custom', colour: '#d6409f', emphasis: 'solid' }} /> },
  },
  'site-banner-translucent': {
    name: 'Site banner, translucent custom colour',
    states: { rest: () => <Sample banner={{ tone: 'custom', colour: 'rgba(214, 64, 159, 0.5)', emphasis: 'solid' }} /> },
  },
  'site-banner-link': {
    name: 'Site banner, link only',
    states: { rest: () => <Sample banner={{ primary: null, dismissible: false, align: 'start', icon: 'info' }} /> },
  },
  'site-banner-dismiss': {
    name: 'Site banner, dismiss only',
    states: { rest: () => <Sample banner={{ primary: null, link: null, tone: 'warning', emphasis: 'solid', title: '' }} /> },
  },
  'site-banner-plain': {
    name: 'Site banner, message only',
    states: { rest: () => <Sample banner={{ primary: null, link: null, dismissible: false, title: '', icon: 'none', tone: 'neutral' }} /> },
  },
  'site-banner-tones': { name: 'Site banner, every tone', states: { rest: AllTones } },
  'site-banner-previews': { name: 'Site banner previews', states: { rest: Previews } },
  'width-preview': {
    name: 'Width preview',
    states: {
      rest: () => (
        <div className="kit-stack">
          <WidthPreview width="narrow" />
          <WidthPreview width="default" />
          <WidthPreview width="wide" />
        </div>
      ),
    },
  },
};
