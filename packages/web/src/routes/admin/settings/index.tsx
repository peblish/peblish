import { settingsOverview } from '@peblish/core/settings/overview';
import { invalidSetting, updateSettingsAs } from '@peblish/core/settings/write';
import { killSwitches, type SiteSettingKey } from '@peblish/schema/site-settings';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { Field } from '../../auth/-ui/form.tsx';
import { SearchText } from '../../auth/-ui/page.tsx';
import { accessOf } from './-access.ts';
import { savePatch, switchPatch } from './-form.ts';
import { AccessNotice, adminHead, AreaField } from './-ui.tsx';

// /admin/settings (R2 pick admin-tabs, its Site tab): identity, the operator's details that fill
// the legal pages, the registration cap, one kill switch per row with its own POST (an emergency
// needs no form edit), and the federation settings. Plain forms: 303 to ?saved=1, or back with
// ?error=settings.invalid&field=<key> naming the field to mark.

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
  /** The text a marked field carries, next to its hint. */
  const mark = (key: SiteSettingKey) => (invalid === key ? t('admin', 'settings.invalid') : undefined);
  const hinted = (key: SiteSettingKey, hint?: string) => (
    <>
      {hint}
      {mark(key) && <span className="fld-error"> {mark(key)}</span>}
    </>
  );
  const attrs = (key: SiteSettingKey) => ({ name: key, form: 'settings-save', 'aria-invalid': invalid === key ? true : undefined });
  return (
    <main className="auth-page admin-page">
      <h1>{t('admin', 'settings.title')}</h1>
      {search.saved && (
        <p className="ok-t" role="status">
          {t('admin', 'settings.saved')}
        </p>
      )}
      {search.error && (
        <p className="auth-error" role="alert">
          {t('admin', 'settings.failed')}
        </p>
      )}
      <form id="settings-save" method="post" action={path} noValidate aria-label={t('admin', 'settings.formLabel')}>
        <input type="hidden" name="intent" value="save" />
        <h2>{t('admin', 'settings.identity')}</h2>
        <Field
          label={t('admin', 'settings.name')}
          hint={hinted('site.name', t('admin', 'settings.name.hint', { host }))}
          {...attrs('site.name')}
          defaultValue={values['site.name']}
          maxLength={40}
          autoComplete="off"
        />
        <AreaField
          label={t('admin', 'settings.description')}
          hint={hinted('site.description', t('admin', 'settings.description.hint'))}
          {...attrs('site.description')}
          defaultValue={values['site.description']}
          maxLength={500}
          rows={3}
        />
        <h2>{t('admin', 'settings.operator')}</h2>
        <p className="hint">{t('admin', 'settings.operator.hint')}</p>
        <Field
          label={t('admin', 'settings.operator.name')}
          hint={hinted('operator.name')}
          {...attrs('operator.name')}
          defaultValue={values['operator.name']}
          maxLength={120}
          autoComplete="off"
        />
        <Field
          label={t('admin', 'settings.contact.email')}
          hint={hinted('contact.email')}
          {...attrs('contact.email')}
          type="email"
          defaultValue={values['contact.email']}
          autoComplete="off"
        />
        <AreaField
          label={t('admin', 'settings.operator.address')}
          hint={hinted('operator.address')}
          {...attrs('operator.address')}
          defaultValue={values['operator.address']}
          maxLength={300}
          rows={3}
        />
        <Field
          label={t('admin', 'settings.operator.jurisdiction')}
          hint={hinted('operator.jurisdiction')}
          {...attrs('operator.jurisdiction')}
          defaultValue={values['operator.jurisdiction']}
          maxLength={80}
          autoComplete="off"
        />
        <h2>{t('admin', 'settings.registration')}</h2>
        <div className="fld">
          <label htmlFor="cap">{t('admin', 'settings.cap')}</label>
          <div className="cap-row">
            <input
              id="cap"
              type="number"
              min={0}
              {...attrs('registration.cap')}
              defaultValue={values['registration.cap']}
              aria-describedby="cap-used"
            />
            <span id="cap-used" className="hint">
              {t('admin', 'settings.cap.used', { count: accounts, cap: values['registration.cap'] })}
              {mark('registration.cap') && <span className="fld-error"> {mark('registration.cap')}</span>}
            </span>
          </div>
        </div>
      </form>
      <section aria-labelledby="switches">
        <h2 id="switches">{t('admin', 'settings.switches')}</h2>
        <p className="hint">{t('admin', 'settings.switches.hint')}</p>
        <ul className="kl">
          {killSwitches.map((key) => {
            const on = values[key];
            return (
              <li key={key} data-switch={key}>
                <div className="grow">
                  <span>
                    <b>{t('admin', `settings.switch.${key}.label`)}</b>
                    {on ? (
                      <span className="stt ok-t">{t('admin', 'settings.state.on')}</span>
                    ) : (
                      <span className="stt paused" role="status">
                        {t('admin', 'settings.state.off')}
                      </span>
                    )}
                  </span>
                  <span>{t('admin', on ? `settings.switch.${key}.on` : `settings.switch.${key}.off`)}</span>
                  <span className="hint">{t('admin', `settings.switch.${key}.help`)}</span>
                </div>
                <form method="post" action={path}>
                  <input type="hidden" name="intent" value="switch" />
                  <input type="hidden" name="key" value={key} />
                  <input type="hidden" name="state" value={on ? 'off' : 'on'} />
                  <Button type="submit" variant="neutral" size="sm">
                    {t('admin', on ? `settings.switch.${key}.pause` : `settings.switch.${key}.resume`)}
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      </section>
      <h2>{t('admin', 'settings.federation')}</h2>
      <div className="chk">
        <input
          id="nsfw"
          type="checkbox"
          {...attrs('remote_nsfw.accepted')}
          defaultChecked={values['remote_nsfw.accepted']}
          aria-describedby="nsfw-hint"
        />
        <div>
          <label htmlFor="nsfw">{t('admin', 'settings.nsfw')}</label>
          <div id="nsfw-hint" className="hint">
            {t('admin', 'settings.nsfw.hint')}
          </div>
        </div>
      </div>
      <AreaField
        label={t('admin', 'settings.trusted')}
        hint={hinted('modlog.trusted_instances', t('admin', 'settings.trusted.hint'))}
        {...attrs('modlog.trusted_instances')}
        defaultValue={values['modlog.trusted_instances'].join('\n')}
        rows={4}
        spellCheck={false}
      />
      <div className="sv">
        <Button type="submit" form="settings-save" variant="primary">
          {t('admin', 'settings.save')}
        </Button>
        <span className="hint">{t('admin', 'settings.save.hint')}</span>
      </div>
    </main>
  );
}
