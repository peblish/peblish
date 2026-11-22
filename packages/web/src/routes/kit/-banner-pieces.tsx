import { bannerIcons, bannerTones, defaultBanner } from '@peblish/schema/banner';
import { siteWidths } from '@peblish/schema/site-settings';
import { Button } from '@peblish/ui/components/button';
import { ColorField } from '@peblish/ui/components/color-field';
import { RadioGroup } from '@peblish/ui/components/radio-group';
import { Select } from '@peblish/ui/components/select';
import { SiteBanner, type SiteBannerContent } from '@peblish/ui/components/site-banner';
import { BannerPreviews, WidthPreview } from '@peblish/ui/components/site-settings-previews';
import { Switch } from '@peblish/ui/components/switch';
import { TextField } from '@peblish/ui/components/text-field';
import { useTranslate } from '../../i18n/use-translate.ts';
import { AreaField } from '../admin/settings/-ui.tsx';
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

// The admin form's controls (routes/admin/settings/-banner-width.tsx), as the form draws them.

function Shown({ on }: { on?: boolean }) {
  const { t } = useTranslate();
  return (
    <Switch label={t('admin', 'settings.banner.enabled')} description={t('admin', 'settings.banner.enabled.hint')} defaultSelected={on} />
  );
}

function Address({ invalid }: { invalid?: boolean }) {
  const { t } = useTranslate();
  return (
    <TextField
      label={t('admin', 'settings.banner.link.href')}
      description={t('admin', 'settings.banner.href.hint')}
      defaultValue={invalid ? 'https://example.test/rules' : '/rules'}
      invalid={invalid}
      errorMessage={invalid ? t('admin', 'settings.banner.error.href') : undefined}
    />
  );
}

function Message({ invalid }: { invalid?: boolean }) {
  const { t } = useTranslate();
  const message = invalid ? '' : full.message;
  return (
    <AreaField
      label={t('admin', 'settings.banner.message')}
      hint={t('admin', 'settings.banner.message.hint', { count: message.length })}
      error={invalid ? t('admin', 'settings.banner.error.message') : undefined}
      defaultValue={message}
      maxLength={140}
      rows={3}
    />
  );
}

function Tone({ tone = 'neutral' }: { tone?: string }) {
  const { t } = useTranslate();
  return (
    <RadioGroup
      label={t('admin', 'settings.banner.tone')}
      orientation="horizontal"
      defaultValue={tone}
      options={bannerTones.map((value) => ({ value, label: t('admin', `settings.banner.tone.${value}`) }))}
    />
  );
}

function Colour({ invalid }: { invalid?: boolean }) {
  const { t } = useTranslate();
  return (
    <ColorField
      label={t('admin', 'settings.banner.colour')}
      description={t('admin', 'settings.banner.colour.hint')}
      defaultValue="#6E4BD8"
      invalid={invalid}
      errorMessage={invalid ? t('admin', 'settings.banner.error.colour') : undefined}
    />
  );
}

function Icon({ icon = 'none' }: { icon?: string }) {
  const { t } = useTranslate();
  return (
    <Select
      label={t('admin', 'settings.banner.icon')}
      defaultValue={icon}
      items={bannerIcons.map((value) => ({ id: value, label: t('admin', `settings.banner.icon.${value}`) }))}
    />
  );
}

function Publish({ disabled, pending }: { disabled?: boolean; pending?: boolean }) {
  const { t } = useTranslate();
  return (
    <Button variant="primary" disabled={disabled} pending={pending}>
      {t('admin', 'settings.banner.publish')}
    </Button>
  );
}

function ShowAgain({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslate();
  return (
    <Button variant="ghost" disabled={disabled}>
      {t('admin', 'settings.banner.showAgain')}
    </Button>
  );
}

function Widths({ width = 'default', pending }: { width?: string; pending?: boolean }) {
  const { t } = useTranslate();
  return (
    <div className="kit-stack">
      <RadioGroup
        label={t('admin', 'settings.width')}
        defaultValue={width}
        options={siteWidths.map((value) => ({ value, label: t('admin', `settings.width.${value}`) }))}
      />
      <Button variant="primary" pending={pending}>
        {t('admin', 'settings.width.save')}
      </Button>
    </div>
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
  'banner-form-shown': { name: 'Banner form, switch', states: { rest: () => <Shown />, selected: () => <Shown on /> } },
  'banner-form-address': { name: 'Banner form, text field', states: { rest: () => <Address />, invalid: () => <Address invalid /> } },
  'banner-form-message': { name: 'Banner form, message', states: { rest: () => <Message />, invalid: () => <Message invalid /> } },
  'banner-form-tone': { name: 'Banner form, tone', states: { rest: () => <Tone />, selected: () => <Tone tone="custom" /> } },
  'banner-form-colour': { name: 'Banner form, colour', states: { rest: () => <Colour />, invalid: () => <Colour invalid /> } },
  'banner-form-icon': { name: 'Banner form, icon', states: { rest: () => <Icon />, selected: () => <Icon icon="wrench" /> } },
  'banner-form-publish': {
    name: 'Banner form, publish',
    states: { rest: () => <Publish />, disabled: () => <Publish disabled />, pending: () => <Publish pending /> },
  },
  'banner-form-show-again': {
    name: 'Banner form, show again',
    states: { rest: () => <ShowAgain />, disabled: () => <ShowAgain disabled /> },
  },
  'width-presets': {
    name: 'Width presets',
    states: { rest: () => <Widths />, selected: () => <Widths width="wide" />, pending: () => <Widths width="wide" pending /> },
  },
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
