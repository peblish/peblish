import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { localHandles } from '@peblish/core/identity/handles';
import { deviceSessions, revokeSession } from '@peblish/core/identity/session';
import { attempt } from '@peblish/core/identity/throttle';
import { changePasswordAs, confirmTotpSetup, pendingTotp, startTotpSetup, takeRecoveryCodes } from '@peblish/core/identity/two-factor';
import type { DeviceSession } from '@peblish/schema/session';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { clientIp, forbidden, formSession, forwardedHeaders, pageSession, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { asFormError, type FormError } from '../../auth/-ui/errors.ts';
import { AuthForm, Field } from '../../auth/-ui/form.tsx';
import { SearchText } from '../../auth/-ui/page.tsx';
import { QrCode } from '../../auth/-ui/qr.tsx';
import { SettingsLayout, SettingsSection, settingsHead } from '../account/-nav.tsx';
import { Badge, Notice } from '../-ui/interim.tsx';

const Search = type({ 'error?': SearchText, 'form?': SearchText, 'saved?': SearchText });
const Body = type({ intent: "'password'", current: 'string', next: 'string' })
  .or({ intent: "'totp-start'", password: 'string' })
  .or({ intent: "'totp-verify'", code: 'string' })
  .or({ intent: "'totp-off'", password: 'string' })
  .or({ intent: "'revoke'", session: 'string.uuid' })
  .or({ intent: "'revoke-others'" });

const loadSecurity = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/settings/security' } });
  const { userId, twoFactorEnabled } = session.view;
  const { host } = await localHandles();
  return {
    host,
    email: session.email,
    admin: session.role === 'admin',
    twoFactorEnabled,
    // Both belong to this session: the one that started the setup, and the one confirming it handed out.
    setup: twoFactorEnabled ? null : await pendingTotp(userId, session.sessionId, session.email),
    // Consumed here: the codes show on the first view after confirming, and never again.
    recoveryCodes: twoFactorEnabled ? await takeRecoveryCodes(userId, session.sessionId) : null,
    sessions: await deviceSessions(userId, session.sessionId),
  };
});

/** better-auth's codes for a wrong password or code on this page. */
function pageError(code: string | undefined): FormError {
  if (code === 'INVALID_PASSWORD') return 'password.wrong';
  if (code === 'PASSWORD_TOO_SHORT') return 'password.too_short';
  if (code === 'PASSWORD_TOO_LONG') return 'password.too_long';
  if (code === 'INVALID_CODE') return 'two_factor.invalid_code';
  return 'generic';
}

export const Route = createFileRoute('/settings/security/')({
  validateSearch: Search,
  loader: () => loadSecurity(),
  head: settingsHead,
  component: Security,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: '/auth/sign-in?redirect=%2Fsettings%2Fsecurity' });
        // A revoke form names its session in the address; every other field is in the body, which wins.
        const body = Body({ ...Object.fromEntries(new URL(request.url).searchParams), ...(await readForm(request)) });
        if (body instanceof type.errors) return reply({ error: 'form.invalid', back: '/settings/security' });
        const page = '/settings/security';
        const api = (await auth()).api;
        const headers = forwardedHeaders(request);
        // Errors name their form, so the message shows next to it (?form=).
        const failed = (error: unknown) => {
          const code = authErrorCode(error);
          if (code === undefined) throw error;
          return reply({ error: pageError(code), back: page, keep: { form: body.intent } });
        };
        // The intents that take the password: wrong ones count against the account and the
        // address (identity/throttle.ts), a right one is refunded.
        const counted =
          body.intent === 'password' || body.intent === 'totp-start' || body.intent === 'totp-off'
            ? await attempt('password', { ip: clientIp(request), id: session.view.userId })
            : null;
        if (counted?.allowed === false) return reply({ error: 'rate.limited', back: page, keep: { form: body.intent } });
        try {
          switch (body.intent) {
            case 'password': {
              // Other sessions end; this one gets a fresh cookie (and keeps its two-factor mark).
              const cookies = await changePasswordAs(session.sessionId, headers, { current: body.current, next: body.next });
              await counted?.refund();
              return reply({ redirect: `${page}?saved=password`, cookies });
            }
            case 'totp-start':
              await startTotpSetup(session.sessionId, session.view.userId, headers, body.password);
              await counted?.refund();
              return reply({ redirect: page });
            case 'totp-verify': {
              // Only confirms a setup in progress; once two-factor is on this changes nothing.
              const cookies = await confirmTotpSetup(session.view.userId, session.sessionId, headers, body.code.replace(/\s/g, ''));
              return reply({ redirect: page, cookies: cookies ?? [] });
            }
            case 'totp-off': {
              const result = await api.disableTwoFactor({ body: { password: body.password }, headers, returnHeaders: true });
              await counted?.refund();
              return reply({ redirect: page, cookies: result.headers.getSetCookie() });
            }
            case 'revoke':
              await revokeSession(session.view.userId, body.session);
              return reply({ redirect: page });
            case 'revoke-others':
              await api.revokeOtherSessions({ headers });
              return reply({ redirect: page });
          }
        } catch (error) {
          return failed(error);
        }
      },
    },
  },
});

function Security() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const errorFor = (form: string) => (search.form === form ? asFormError(search.error) : undefined);
  useRouteHydrated();
  return (
    <SettingsLayout admin={data.admin} title={t('settings', 'security.title')}>
      <SettingsSection id="sec-password" title={t('settings', 'security.password')}>
        {search.saved === 'password' && <Notice tone="success">{t('settings', 'security.changed')}</Notice>}
        <AuthForm action="/settings/security" label={t('settings', 'security.password')} error={errorFor('password')}>
          <Field label={t('settings', 'security.current')} name="current" type="password" required autoComplete="current-password" />
          <Field
            label={t('settings', 'security.new')}
            name="next"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            hint={t('settings', 'security.newHint')}
          />
          <Button type="submit" variant="primary" name="intent" value="password">
            {t('settings', 'security.change')}
          </Button>
        </AuthForm>
      </SettingsSection>
      <TwoFactorSection data={data} error={errorFor} />
      <Sessions sessions={data.sessions} />
    </SettingsLayout>
  );
}

type SecurityData = ReturnType<typeof Route.useLoaderData>;

// Each form's intent rides on its submit button (name="intent"), which is also the button Enter
// presses, so no form needs a hidden field for it.

function TwoFactorSection({ data, error }: { data: SecurityData; error: (form: string) => FormError | undefined }) {
  const { t } = useTranslate();
  return (
    <SettingsSection id="two-factor" title={t('settings', 'security.twoFactor')}>
      {data.twoFactorEnabled ? (
        <>
          <Text as="p" color="muted">
            <Badge tone="success">{t('settings', 'security.on')}</Badge> {t('settings', 'security.onBody')}
          </Text>
          {data.recoveryCodes && <RecoveryCodes codes={data.recoveryCodes} host={data.host} />}
          <AuthForm action="/settings/security" label={t('settings', 'security.turnOff')} error={error('totp-off')}>
            <Field
              label={t('settings', 'security.offPassword')}
              name="password"
              type="password"
              required
              autoComplete="current-password"
              hint={t('settings', 'security.turnOffHint')}
            />
            <Button type="submit" variant="danger-neutral" name="intent" value="totp-off">
              {t('settings', 'security.turnOff')}
            </Button>
          </AuthForm>
        </>
      ) : (
        <>
          <Text as="p" color="muted">
            <Badge tone="danger">{t('settings', 'security.off')}</Badge> {t('settings', 'security.offBody')}
          </Text>
          {data.setup ? (
            <ol className="settings__steps">
              <li>
                <Text variant="title" size="sm">
                  1
                </Text>
                <div>
                  <Text variant="title" size="sm">
                    {t('settings', 'security.scan')}
                  </Text>
                  <div className="settings__qr">
                    <QrCode value={data.setup.uri} label={t('settings', 'security.qr')} />
                    <div>
                      <Text as="p" size="sm" color="muted">
                        {t('settings', 'security.cantScan')}
                      </Text>
                      <Text as="p" variant="mono" data-testid="totp-key">
                        {data.setup.key.match(/.{1,4}/g)?.join(' ')}
                      </Text>
                      <Text as="p" size="sm" color="muted">
                        {t('settings', 'security.accountLine', { email: data.email })}
                        <br />
                        {t('settings', 'security.issuerLine', { host: data.host })}
                      </Text>
                    </div>
                  </div>
                </div>
              </li>
              <li>
                <Text variant="title" size="sm">
                  2
                </Text>
                <div>
                  <Text variant="title" size="sm">
                    {t('settings', 'security.enterCode')}
                  </Text>
                  <AuthForm action="/settings/security" label={t('settings', 'security.enterCode')} error={error('totp-verify')}>
                    <Field
                      label={t('settings', 'security.code')}
                      name="code"
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                    />
                    <Button type="submit" variant="primary" name="intent" value="totp-verify">
                      {t('settings', 'security.verify')}
                    </Button>
                  </AuthForm>
                </div>
              </li>
              <li>
                <Text variant="title" size="sm">
                  3
                </Text>
                <div>
                  <Text variant="title" size="sm">
                    {t('settings', 'security.saveCodes')}
                  </Text>
                </div>
              </li>
            </ol>
          ) : (
            <AuthForm action="/settings/security" label={t('settings', 'security.start')} error={error('totp-start')}>
              <Field
                label={t('settings', 'security.startPassword')}
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
              <Button type="submit" variant="primary" name="intent" value="totp-start">
                {t('settings', 'security.start')}
              </Button>
            </AuthForm>
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** Step 3, after confirming: the codes, shown once, with copy and download once hydrated. */
function RecoveryCodes({ codes, host }: { codes: string[]; host: string }) {
  const { t } = useTranslate();
  const [copied, setCopied] = useState(false);
  const text = `${host} recovery codes\n\n${codes.join('\n')}\n`;
  const download = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    link.download = `${host}-recovery-codes.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <Card.Root variant="filled" padding="sm" className="settings__body">
      <Text as="p" variant="title" size="sm">
        {t('settings', 'security.saveCodes')}
      </Text>
      <ul className="settings__codes" aria-label={t('settings', 'security.codes')} data-testid="recovery-codes">
        {codes.map((code) => (
          <li key={code}>
            <Text variant="mono">{code}</Text>
          </li>
        ))}
      </ul>
      <div className="settings__actions">
        <Button
          variant="neutral"
          onActivate={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? t('settings', 'security.copied') : t('settings', 'security.copy')}
        </Button>
        <Button variant="neutral" onActivate={download}>
          {t('settings', 'security.download')}
        </Button>
      </div>
      <Checkbox description={t('settings', 'security.savedHint')}>{t('settings', 'security.saved')}</Checkbox>
      <Link href="/settings/security">{t('settings', 'security.done')}</Link>
    </Card.Root>
  );
}

function Sessions({ sessions }: { sessions: DeviceSession[] }) {
  const { locale, t } = useTranslate();
  const when = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <SettingsSection id="sec-sessions" title={t('settings', 'security.sessions')}>
      <ul className="settings__rows">
        {sessions.map((session) => {
          const device =
            session.browser && session.os
              ? t('settings', 'security.device', { browser: session.browser, os: session.os })
              : (session.browser ?? session.os ?? t('settings', 'security.unknownDevice'));
          const times = { active: when.format(new Date(session.lastActiveAt)), created: day.format(new Date(session.createdAt)) };
          return (
            <li key={session.id} data-testid="session">
              <div>
                <span className="settings__row-name">
                  <Text variant="label" size="md">
                    {device}
                  </Text>
                  {session.current && <Badge tone="warning">{t('settings', 'security.thisDevice')}</Badge>}
                </span>
                <Text size="sm" color="muted">
                  {session.ip ? t('settings', 'security.meta', { ip: session.ip, ...times }) : t('settings', 'security.metaNoIp', times)}
                </Text>
              </div>
              {session.current ? (
                <Text size="sm" color="muted">
                  {t('settings', 'security.currentSession')}
                </Text>
              ) : (
                // The session id rides in the address (the handler reads the query under the form).
                <form method="post" action={`/settings/security?${new URLSearchParams({ session: session.id })}`}>
                  <Button type="submit" variant="neutral" size="sm" name="intent" value="revoke">
                    {t('settings', 'security.revoke')}
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {sessions.length > 1 && (
        <form method="post" action="/settings/security">
          <Button type="submit" variant="neutral" name="intent" value="revoke-others">
            {t('settings', 'security.revokeOthers')}
          </Button>
        </form>
      )}
    </SettingsSection>
  );
}
