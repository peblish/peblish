import { bannerIcons, bannerTones, type SiteBanner } from '@peblish/schema/banner';
import { siteWidths, type SiteWidth } from '@peblish/schema/site-settings';
import { Button } from '@peblish/ui/components/button';
import { ColorField } from '@peblish/ui/components/color-field';
import { Notice } from '@peblish/ui/components/notice';
import { RadioGroup } from '@peblish/ui/components/radio-group';
import { Select } from '@peblish/ui/components/select';
import { BannerPreviews, WidthPreview } from '@peblish/ui/components/site-settings-previews';
import { Switch } from '@peblish/ui/components/switch';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { getRouteApi } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { NoEnterSubmit } from '../-no-enter-submit.tsx';
import { showBannerAgain, useBannerDismissed } from '../../../shell/banner.tsx';
import { bannerPatch, type BannerField } from './-form.ts';
import { AreaField, SectionTitle } from './-ui.tsx';

// The Site banner and Layout sections of /admin/settings (Commons, the mock's Admin view): each a plain
// form of its own (intent `banner`, intent `width`) that answers 303 to ?saved=<intent> at its section, or
// back with ?error=settings.invalid&field=<name>. Hydrated, the banner form checks itself before it posts,
// marks and focuses the field it refuses, and posts once.

const root = getRouteApi('__root__');
const path = '/admin/settings';

/** A form that posts once: a second submit while the first is on its way is dropped. */
function useSendOnce() {
  const [sending, setSending] = useState(false);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (sending) event.preventDefault();
    else setSending(true);
  };
  return { sending, onSubmit };
}

const fieldsOf = (form: HTMLFormElement) =>
  Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, typeof value === 'string' ? value : '']));

/** What the page says above a section's form after its post: saved, or refused (`failed`). */
function Answer({ saved, failed, savedText, unreadable }: { saved: boolean; failed: boolean; savedText: string; unreadable?: string }) {
  const { t } = useTranslate();
  if (saved)
    return (
      <Notice role="status" tone="success">
        {savedText}
      </Notice>
    );
  if (failed)
    return (
      <Notice role="alert" tone="danger">
        {t('admin', 'settings.failed')}
      </Notice>
    );
  // A stored value the contract refuses is shown at its default; saving replaces it (core settings read.ts, write.ts).
  if (unreadable)
    return (
      <Notice role="alert" tone="warning">
        {unreadable}
      </Notice>
    );
  return null;
}

export function BannerSection({
  banner,
  saved,
  failed,
  invalid,
  unreadable,
}: {
  banner: SiteBanner;
  saved: boolean;
  failed: boolean;
  /** The stored banner failed its contract and is shown here, and on every page, as the default (off). */
  unreadable: boolean;
  /** The field the server refused. */
  invalid: string | undefined;
}) {
  const { t } = useTranslate();
  const hydrated = useHydrated();
  const { bannerDismissed } = root.useLoaderData();
  const dismissedHere = useBannerDismissed(banner.revision, bannerDismissed);
  const [draft, setDraft] = useState(banner);
  const [problem, setProblem] = useState<string | undefined>(invalid);
  const { sending, onSubmit } = useSendOnce();
  const set =
    <K extends keyof SiteBanner>(key: K) =>
    (value: SiteBanner[K]) => {
      setProblem(undefined);
      setDraft((current) => ({ ...current, [key]: value }));
    };
  const action = (slot: 'primary' | 'link', part: 'label' | 'href') => (value: string) => {
    setProblem(undefined);
    setDraft((current) => {
      const before = current[slot] ?? { label: '', href: '' };
      const next = { ...before, [part]: value };
      // The preview shows an action once it has a label, as the published banner does.
      return { ...current, [slot]: next.label.trim() ? next : null };
    });
  };
  /** A field's name, and its mark while it is the one refused. */
  const field = (name: BannerField) => ({
    name,
    invalid: problem === name,
    ...(problem === name && { errorMessage: t('admin', `settings.banner.error.${errorKind(name)}`) }),
  });
  const [primaryLabel, primaryHref] = [banner.primary?.label ?? '', banner.primary?.href ?? ''];
  const [linkLabel, linkHref] = [banner.link?.label ?? '', banner.link?.href ?? ''];

  return (
    <section className="adm-section adm-banner" aria-labelledby="settings-banner" id="banner">
      <SectionTitle id="settings-banner">{t('admin', 'settings.banner')}</SectionTitle>
      <Answer
        saved={saved}
        failed={failed}
        savedText={t('admin', banner.enabled ? 'settings.banner.published' : 'settings.banner.off')}
        unreadable={unreadable ? t('admin', 'settings.banner.unreadable') : undefined}
      />
      <BannerPreviews
        banner={draft}
        labels={{
          light: { caption: t('admin', 'settings.banner.preview.light'), region: t('admin', 'settings.banner.preview.region.light') },
          dark: { caption: t('admin', 'settings.banner.preview.dark'), region: t('admin', 'settings.banner.preview.region.dark') },
        }}
        dismissLabel={t('shell', 'banner.dismiss')}
      />
      <form
        className="adm-form"
        method="post"
        action={path}
        noValidate
        aria-labelledby="settings-banner"
        onSubmit={(event) => {
          const checked = bannerPatch(fieldsOf(event.currentTarget));
          if ('field' in checked) {
            event.preventDefault();
            setProblem(checked.field ?? undefined);
            // A field that posts through a hidden input (Mux's ColorField) is focused at its visible one beside it.
            const named = event.currentTarget.querySelector<HTMLInputElement>(`[name="${checked.field}"]`);
            const visible =
              named?.type === 'hidden' ? named.parentElement?.querySelector<HTMLElement>('input:not([type="hidden"])') : named;
            visible?.focus();
            return;
          }
          onSubmit(event);
        }}
      >
        {/* Enter never publishes a notice every page shows: in the colour field it applies the colour, as Mux's ColorField
            does. The intent is on Publish itself, so a post from anything else (NoEnterSubmit's fallback, with scripts
            off) names none and the server refuses it. */}
        <NoEnterSubmit />
        <Switch
          label={t('admin', 'settings.banner.enabled')}
          description={t('admin', 'settings.banner.enabled.hint')}
          name="banner.enabled"
          value="on"
          defaultSelected={banner.enabled}
          onChange={set('enabled')}
        />
        <TextField
          label={t('admin', 'settings.banner.title')}
          description={t('admin', 'settings.banner.title.hint')}
          {...field('banner.title')}
          defaultValue={banner.title}
          onChange={set('title')}
          maxLength={32}
          autoComplete="off"
        />
        <AreaField
          label={t('admin', 'settings.banner.message')}
          hint={t('admin', 'settings.banner.message.hint', { count: draft.message.length })}
          error={field('banner.message').errorMessage}
          name="banner.message"
          defaultValue={banner.message}
          onChange={(event) => set('message')(event.currentTarget.value)}
          maxLength={140}
          rows={3}
        />
        <div className="adm-pair">
          <TextField
            label={t('admin', 'settings.banner.primary.label')}
            {...field('banner.primary.label')}
            defaultValue={primaryLabel}
            onChange={action('primary', 'label')}
            maxLength={16}
            autoComplete="off"
          />
          <TextField
            label={t('admin', 'settings.banner.primary.href')}
            description={t('admin', 'settings.banner.href.hint')}
            {...field('banner.primary.href')}
            defaultValue={primaryHref}
            onChange={action('primary', 'href')}
            placeholder="/about"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div className="adm-pair">
          <TextField
            label={t('admin', 'settings.banner.link.label')}
            {...field('banner.link.label')}
            defaultValue={linkLabel}
            onChange={action('link', 'label')}
            maxLength={16}
            autoComplete="off"
          />
          <TextField
            label={t('admin', 'settings.banner.link.href')}
            description={t('admin', 'settings.banner.href.hint')}
            {...field('banner.link.href')}
            defaultValue={linkHref}
            onChange={action('link', 'href')}
            placeholder="/rules"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <RadioGroup
          label={t('admin', 'settings.banner.tone')}
          orientation="horizontal"
          {...field('banner.tone')}
          defaultValue={banner.tone}
          onChange={(value) => set('tone')(bannerTones.find((tone) => tone === value) ?? 'neutral')}
          options={bannerTones.map((tone) => ({ value: tone, label: t('admin', `settings.banner.tone.${tone}`) }))}
        />
        {/* Shown for Custom only (adm-banner__colour in -admin.css), by CSS, so it follows the choice with scripts off too. */}
        <div className="adm-banner__colour">
          <ColorField
            label={t('admin', 'settings.banner.colour')}
            description={t('admin', 'settings.banner.colour.hint')}
            {...field('banner.colour')}
            defaultValue={banner.colour}
            onChange={(value) => set('colour')(typeof value === 'string' ? value : '')}
          />
        </div>
        <div className="adm-pair">
          <RadioGroup
            label={t('admin', 'settings.banner.emphasis')}
            orientation="horizontal"
            {...field('banner.emphasis')}
            defaultValue={banner.emphasis}
            onChange={(value) => set('emphasis')(value === 'solid' ? 'solid' : 'subtle')}
            options={[
              { value: 'subtle', label: t('admin', 'settings.banner.emphasis.subtle') },
              { value: 'solid', label: t('admin', 'settings.banner.emphasis.solid') },
            ]}
          />
          <RadioGroup
            label={t('admin', 'settings.banner.align')}
            orientation="horizontal"
            {...field('banner.align')}
            defaultValue={banner.align}
            onChange={(value) => set('align')(value === 'start' ? 'start' : 'center')}
            options={[
              { value: 'center', label: t('admin', 'settings.banner.align.center') },
              { value: 'start', label: t('admin', 'settings.banner.align.start') },
            ]}
          />
        </div>
        <div className="adm-pair">
          <Select
            label={t('admin', 'settings.banner.icon')}
            {...field('banner.icon')}
            defaultValue={banner.icon}
            onChange={(value) => set('icon')(bannerIcons.find((icon) => icon === value) ?? 'none')}
            items={bannerIcons.map((icon) => ({ id: icon, label: t('admin', `settings.banner.icon.${icon}`) }))}
          />
          <Switch
            label={t('admin', 'settings.banner.dismissible')}
            description={t('admin', 'settings.banner.dismissible.hint')}
            name="banner.dismissible"
            value="on"
            defaultSelected={banner.dismissible}
            onChange={set('dismissible')}
          />
        </div>
        <div className="adm-actions">
          <Text color="muted" size="sm">
            {t('admin', 'settings.banner.publish.hint')}
          </Text>
          {/* Needs scripts: the dismissal is this browser's cookie. Disabled until it has one for this banner. */}
          <Button
            variant="ghost"
            disabled={!hydrated || !banner.enabled || !dismissedHere}
            onActivate={() => showBannerAgain(banner.revision)}
          >
            {t('admin', 'settings.banner.showAgain')}
          </Button>
          <Button type="submit" name="intent" value="banner" variant="primary" pending={sending}>
            {t('admin', 'settings.banner.publish')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Which of the banner's error messages a field takes. */
function errorKind(name: BannerField): 'message' | 'title' | 'colour' | 'label' | 'href' | 'choice' {
  switch (name) {
    case 'banner.message':
      return 'message';
    case 'banner.title':
      return 'title';
    case 'banner.colour':
      return 'colour';
    case 'banner.primary.label':
    case 'banner.link.label':
      return 'label';
    case 'banner.primary.href':
    case 'banner.link.href':
      return 'href';
    default:
      return 'choice';
  }
}

export function WidthSection({
  width,
  saved,
  failed,
  unreadable,
}: {
  width: SiteWidth;
  saved: boolean;
  failed: boolean;
  unreadable: boolean;
}) {
  const { t } = useTranslate();
  const [draft, setDraft] = useState(width);
  const { sending, onSubmit } = useSendOnce();
  return (
    <section className="adm-section" aria-labelledby="settings-layout" id="layout">
      <SectionTitle id="settings-layout">{t('admin', 'settings.layout')}</SectionTitle>
      <Answer
        saved={saved}
        failed={failed}
        savedText={t('admin', 'settings.saved')}
        unreadable={unreadable ? t('admin', 'settings.width.unreadable') : undefined}
      />
      <form className="adm-form" method="post" action={path} aria-labelledby="settings-layout" onSubmit={onSubmit}>
        <RadioGroup
          label={t('admin', 'settings.width')}
          name="site.width"
          defaultValue={width}
          onChange={(value) => setDraft(siteWidths.find((preset) => preset === value) ?? 'default')}
          options={siteWidths.map((preset) => ({ value: preset, label: t('admin', `settings.width.${preset}`) }))}
        />
        <Text as="p" color="muted" size="sm">
          {t('admin', 'settings.width.hint')}
        </Text>
        <WidthPreview width={draft} />
        <div className="adm-actions">
          {/* The intent on the button, as Publish has it; Enter on a preset saves through it, the form's one button. */}
          <Button type="submit" name="intent" value="width" variant="primary" pending={sending}>
            {t('admin', 'settings.width.save')}
          </Button>
        </div>
      </form>
    </section>
  );
}
