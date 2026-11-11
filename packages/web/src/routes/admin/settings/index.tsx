import { settingsOverview } from '@peblish/core/settings/overview';
import { invalidSetting, updateSettingsAs } from '@peblish/core/settings/write';
import { killSwitches, type SiteSettingKey } from '@peblish/schema/site-settings';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { Input } from '@peblish/ui/components/input';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { SearchText } from '../../auth/-route.ts';
import { accessOf } from './-access.ts';
import { savePatch, switchPatch } from './-form.ts';
import { adminHead } from './-head.ts';
import { AccessNotice, AdminTitle, AreaField, SectionTitle } from './-ui.tsx';

// /admin/settings (R2 pick admin-tabs, its Site tab): identity, the operator's details that fill
// the legal pages, the registration cap and the federation settings in one form, then one kill
// switch per row with its own POST (an emergency needs no form edit). The switches sit below the
// form because a form cannot hold another and Mux's fields take no `form` attribute. Plain
// forms: 303 to ?saved=1, or back with ?error=settings.invalid&field=<key> naming the field to mark.

const Search = type({ 'saved?': SearchText, 'error?': SearchText, 'field?': SearchText });
const path = '/admin/settings';
const Intent = type({ intent: "'save' | 'switch'" });

const loadSettings = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: path } });
  const access = accessOf(session);
  // Signed in but not an admin with two-factor on: the denial copy, answered as a 403 (as the report queue does).
  if (access !== 'ok') {
    setResponseStatus(403);
    return { access } as const;
  }
  return { access, ...(await settingsOverview()) } as const;
});

export const Route = createFileRoute('/admin/settings/')({
  validateSearch: Search,
  loader: () => loadSettings(),
  head: adminHead('settings.title'),
  component: Settings,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: `/auth/sign-in?redirect=${encodeURIComponent(path)}` });
        const form = await readForm(request);
        const intent = Intent(form);
        const patch = intent instanceof type.errors ? null : intent.intent === 'save' ? savePatch(form) : switchPatch(form);
        if (!patch) return reply({ redirect: `${path}?error=settings.invalid` });
        const result = await updateSettingsAs(principalOf(session.view), patch);
        if (result.ok) return reply({ redirect: `${path}?saved=1` });
        const field = result.reason === 'settings.invalid' ? invalidSetting(patch) : null;
        return reply({ redirect: `${path}?${new URLSearchParams({ error: result.reason, ...(field && { field }) })}` });
      },
    },
  },
});

function Settings() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok') return <AccessNotice access={data.access} title={t('admin', 'settings.title')} />;
  const { values, accounts, host } = data;
  const invalid = search.error === 'settings.invalid' ? search.field : undefined;
  /** A field's name, and its error while the server named it. */
  const field = (key: SiteSettingKey) => ({
    name: key,
    invalid: invalid === key,
    ...(invalid === key && { errorMessage: t('admin', 'settings.invalid') }),
  });
  return (
    <main className="pb-page adm-page">
      <AdminTitle>{t('admin', 'settings.title')}</AdminTitle>
      {search.saved && (
        <Notice role="status" tone="success">
          {t('admin', 'settings.saved')}
        </Notice>
      )}
      {search.error && (
        <Notice role="alert" tone="danger">
          {t('admin', 'settings.failed')}
        </Notice>
      )}
      <form className="adm-form" method="post" action={path} noValidate aria-label={t('admin', 'settings.formLabel')}>
        <Input.Input type="hidden" name="intent" value="save" />
        <section className="adm-section" aria-labelledby="settings-identity">
          <SectionTitle id="settings-identity">{t('admin', 'settings.identity')}</SectionTitle>
          <TextField
            label={t('admin', 'settings.name')}
            description={t('admin', 'settings.name.hint', { host })}
            {...field('site.name')}
            defaultValue={values['site.name']}
            maxLength={40}
            autoComplete="off"
          />
          <AreaField
            label={t('admin', 'settings.description')}
            hint={t('admin', 'settings.description.hint')}
            error={field('site.description').errorMessage}
            name="site.description"
            defaultValue={values['site.description']}
            maxLength={500}
            rows={3}
          />
        </section>
        <section className="adm-section" aria-labelledby="settings-operator">
          <SectionTitle id="settings-operator">{t('admin', 'settings.operator')}</SectionTitle>
          <Text as="p" color="muted">
            {t('admin', 'settings.operator.hint')}
          </Text>
          <TextField
            label={t('admin', 'settings.operator.name')}
            {...field('operator.name')}
            defaultValue={values['operator.name']}
            maxLength={120}
            autoComplete="off"
          />
          <TextField
            label={t('admin', 'settings.contact.email')}
            {...field('contact.email')}
            type="email"
            defaultValue={values['contact.email']}
            autoComplete="off"
          />
          <AreaField
            label={t('admin', 'settings.operator.address')}
            error={field('operator.address').errorMessage}
            name="operator.address"
            defaultValue={values['operator.address']}
            maxLength={300}
            rows={3}
          />
          <TextField
            label={t('admin', 'settings.operator.jurisdiction')}
            {...field('operator.jurisdiction')}
            defaultValue={values['operator.jurisdiction']}
            maxLength={80}
            autoComplete="off"
          />
        </section>
        <section className="adm-section" aria-labelledby="settings-registration">
          <SectionTitle id="settings-registration">{t('admin', 'settings.registration')}</SectionTitle>
          <Input.Root invalid={invalid === 'registration.cap'} defaultValue={String(values['registration.cap'])}>
            <Input.Label>{t('admin', 'settings.cap')}</Input.Label>
            <Input.Input className="adm-number" name="registration.cap" type="number" min={0} inputMode="numeric" />
            <Input.Description>{t('admin', 'settings.cap.used', { count: accounts, cap: values['registration.cap'] })}</Input.Description>
            {invalid === 'registration.cap' && <Input.Error>{t('admin', 'settings.invalid')}</Input.Error>}
          </Input.Root>
        </section>
        <section className="adm-section" aria-labelledby="settings-federation">
          <SectionTitle id="settings-federation">{t('admin', 'settings.federation')}</SectionTitle>
          <Checkbox
            {...field('remote_nsfw.accepted')}
            value="on"
            defaultChecked={values['remote_nsfw.accepted']}
            description={t('admin', 'settings.nsfw.hint')}
          >
            {t('admin', 'settings.nsfw')}
          </Checkbox>
          <AreaField
            label={t('admin', 'settings.trusted')}
            hint={t('admin', 'settings.trusted.hint')}
            error={field('modlog.trusted_instances').errorMessage}
            name="modlog.trusted_instances"
            defaultValue={values['modlog.trusted_instances'].join('\n')}
            rows={4}
            spellCheck={false}
          />
        </section>
        <div className="adm-actions">
          <Button type="submit" variant="primary">
            {t('admin', 'settings.save')}
          </Button>
          <Text color="muted" size="sm">
            {t('admin', 'settings.save.hint')}
          </Text>
        </div>
      </form>
      <section className="adm-section" aria-labelledby="switches">
        <SectionTitle id="switches">{t('admin', 'settings.switches')}</SectionTitle>
        <Text as="p" color="muted">
          {t('admin', 'settings.switches.hint')}
        </Text>
        <Card.Root variant="outlined" padding="sm">
          <ul className="adm-switches">
            {killSwitches.map((key) => (
              <KillSwitch key={key} name={key} on={values[key]} />
            ))}
          </ul>
        </Card.Root>
      </section>
    </main>
  );
}

/**
 * One kill switch: its name and state, what it does now, what pausing does, and one button that
 * posts the opposite state. A plain form, so it works before hydration and with scripts off.
 */
function KillSwitch({ name, on }: { name: (typeof killSwitches)[number]; on: boolean }) {
  const { t } = useTranslate();
  const help = `switch-${name.replace('.', '-')}-help`;
  return (
    <li className="adm-switch" data-switch={name}>
      <div className="adm-switch__text">
        <span className="adm-switch__name">
          <Text variant="label" size="md">
            {t('admin', `settings.switch.${name}.label`)}
          </Text>
          {on ? (
            <Badge tone="success">{t('admin', 'settings.state.on')}</Badge>
          ) : (
            <Badge tone="warning" role="status">
              {t('admin', 'settings.state.off')}
            </Badge>
          )}
        </span>
        <Text>{t('admin', on ? `settings.switch.${name}.on` : `settings.switch.${name}.off`)}</Text>
        <Text color="muted" size="sm" id={help}>
          {t('admin', `settings.switch.${name}.help`)}
        </Text>
      </div>
      <form method="post" action={path}>
        <Input.Input type="hidden" name="intent" value="switch" />
        <Input.Input type="hidden" name="key" value={name} />
        <Input.Input type="hidden" name="state" value={on ? 'off' : 'on'} />
        <Button type="submit" variant={on ? 'neutral' : 'primary'} size="sm" aria-describedby={help}>
          {t('admin', on ? `settings.switch.${name}.pause` : `settings.switch.${name}.resume`)}
        </Button>
      </form>
    </li>
  );
}
