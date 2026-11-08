import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { localHandles } from '@peblish/core/identity/handles';
import { deviceSessions, revokeSession } from '@peblish/core/identity/session';
import { confirmTotpSetup, pendingTotp, takeRecoveryCodes } from '@peblish/core/identity/two-factor';
import type { DeviceSession } from '@peblish/schema/session';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, forwardedHeaders, readForm, pageSession, respond, sameOrigin, sessionOf } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { asFormError, type FormError } from '../../auth/-ui/errors.ts';
import { AuthForm, Field } from '../../auth/-ui/form.tsx';
import { authHead, SearchText } from '../../auth/-ui/page.tsx';
import { QrCode } from '../../auth/-ui/qr.tsx';
import { SettingsLayout } from '../account/-nav.tsx';

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
    setup: twoFactorEnabled ? null : await pendingTotp(userId, session.email),
    // Consumed here: the codes show on the first view after confirming, and never again.
    recoveryCodes: twoFactorEnabled ? await takeRecoveryCodes(userId) : null,
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
  head: authHead,
  component: Security,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const session = await sessionOf(request);
        if (!session) return respond(request, { redirect: '/auth/sign-in?redirect=%2Fsettings%2Fsecurity' });
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', back: '/settings/security' });
        const page = '/settings/security';
        const api = (await auth()).api;
        const headers = forwardedHeaders(request);
        // Errors name their form, so the message shows next to it (?form=).
        const failed = (error: unknown) => {
          const code = authErrorCode(error);
          if (code === undefined) throw error;
          return respond(request, { error: pageError(code), back: page, keep: { form: body.intent } });
        };
        try {
          switch (body.intent) {
            case 'password': {
              // Other sessions end; this one gets a fresh cookie.
              const result = await api.changePassword({
                body: { currentPassword: body.current, newPassword: body.next, revokeOtherSessions: true },
                headers,
                returnHeaders: true,
              });
              return respond(request, { redirect: `${page}?saved=password`, cookies: result.headers.getSetCookie() });
            }
            case 'totp-start':
              await api.enableTwoFactor({ body: { password: body.password }, headers });
              return respond(request, { redirect: page });
            case 'totp-verify': {
              // Only confirms a setup in progress; once two-factor is on this changes nothing.
              const cookies = await confirmTotpSetup(session.view.userId, headers, body.code.replace(/\s/g, ''));
              return respond(request, { redirect: page, cookies: cookies ?? [] });
            }
            case 'totp-off': {
              const result = await api.disableTwoFactor({ body: { password: body.password }, headers, returnHeaders: true });
              return respond(request, { redirect: page, cookies: result.headers.getSetCookie() });
            }
            case 'revoke':
              await revokeSession(session.view.userId, body.session);
              return respond(request, { redirect: page });
            case 'revoke-others':
              await api.revokeOtherSessions({ headers });
              return respond(request, { redirect: page });
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
    <SettingsLayout admin={data.admin}>
      <h1>{t('settings', 'security.title')}</h1>
      <section className="sec" aria-labelledby="sec-password">
        <h2 id="sec-password">{t('settings', 'security.password')}</h2>
        {search.saved === 'password' && <p className="ok-t">{t('settings', 'security.changed')}</p>}
        <AuthForm action="/settings/security" label={t('settings', 'security.password')} error={errorFor('password')}>
          <input type="hidden" name="intent" value="password" />
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
          <Button type="submit" variant="primary">
            {t('settings', 'security.change')}
          </Button>
        </AuthForm>
      </section>
      <TwoFactorSection data={data} error={errorFor} />
      <Sessions sessions={data.sessions} />
    </SettingsLayout>
  );
}

type SecurityData = ReturnType<typeof Route.useLoaderData>;

function TwoFactorSection({ data, error }: { data: SecurityData; error: (form: string) => FormError | undefined }) {
  const { t } = useTranslate();
  return (
    <section className="sec" id="two-factor" aria-labelledby="sec-2fa">
      <h2 id="sec-2fa">{t('settings', 'security.twoFactor')}</h2>
      {data.twoFactorEnabled ? (
        <>
          <p className="hint">
            <b className="ok-t">{t('settings', 'security.on')}</b> {t('settings', 'security.onBody')}
          </p>
          {data.recoveryCodes && <RecoveryCodes codes={data.recoveryCodes} host={data.host} />}
          <AuthForm action="/settings/security" label={t('settings', 'security.turnOff')} error={error('totp-off')}>
            <input type="hidden" name="intent" value="totp-off" />
            <Field
              label={t('settings', 'security.offPassword')}
              name="password"
              type="password"
              required
              autoComplete="current-password"
              hint={t('settings', 'security.turnOffHint')}
            />
            <Button type="submit" variant="danger-neutral">
              {t('settings', 'security.turnOff')}
            </Button>
          </AuthForm>
        </>
      ) : (
        <>
          <p className="hint">
            <b className="err-t">{t('settings', 'security.off')}</b> {t('settings', 'security.offBody')}
          </p>
          {data.setup ? (
            <ol className="steps">
              <li>
                <span className="n">1</span>
                <div>
                  <b>{t('settings', 'security.scan')}</b>
                  <div className="qr-row">
                    <QrCode value={data.setup.uri} label={t('settings', 'security.qr')} />
                    <div>
                      <p className="hint">{t('settings', 'security.cantScan')}</p>
                      <p className="mono" data-testid="totp-key">
                        {data.setup.key.match(/.{1,4}/g)?.join(' ')}
                      </p>
                      <p className="hint">
                        {t('settings', 'security.accountLine', { email: data.email })}
                        <br />
                        {t('settings', 'security.issuerLine', { host: data.host })}
                      </p>
                    </div>
                  </div>
                </div>
              </li>
              <li>
                <span className="n">2</span>
                <div>
                  <b>{t('settings', 'security.enterCode')}</b>
                  <AuthForm action="/settings/security" label={t('settings', 'security.enterCode')} error={error('totp-verify')}>
                    <input type="hidden" name="intent" value="totp-verify" />
                    <Field
                      label={t('settings', 'security.code')}
                      name="code"
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      className="code-input"
                    />
                    <Button type="submit" variant="primary">
                      {t('settings', 'security.verify')}
                    </Button>
                  </AuthForm>
                </div>
              </li>
              <li>
                <span className="n">3</span>
                <div>
                  <b>{t('settings', 'security.saveCodes')}</b>
                </div>
              </li>
            </ol>
          ) : (
            <AuthForm action="/settings/security" label={t('settings', 'security.start')} error={error('totp-start')}>
              <input type="hidden" name="intent" value="totp-start" />
              <Field
                label={t('settings', 'security.startPassword')}
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
              <Button type="submit" variant="primary">
                {t('settings', 'security.start')}
              </Button>
            </AuthForm>
          )}
        </>
      )}
    </section>
  );
}

/** Step 3, after confirming: the codes, shown once, with copy and download once hydrated. */
function RecoveryCodes({ codes, host }: { codes: string[]; host: string }) {
  const { t } = useTranslate();
  const [copied, setCopied] = useState(false);
  const text = `${host} recovery codes\n\n${codes.join('\n')}\n`;
  return (
    <div className="auth-note">
      <b>{t('settings', 'security.saveCodes')}</b>
      <ul className="codes mono" aria-label={t('settings', 'security.codes')} data-testid="recovery-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="btns">
        <Button
          variant="neutral"
          onActivate={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? t('settings', 'security.copied') : t('settings', 'security.copy')}
        </Button>
        <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download={`${host}-recovery-codes.txt`}>
          {t('settings', 'security.download')}
        </a>
      </div>
      <label className="chk">
        <input type="checkbox" />
        <span>
          {t('settings', 'security.saved')}
          <span className="hint"> {t('settings', 'security.savedHint')}</span>
        </span>
      </label>
      <a href="/settings/security">{t('settings', 'security.done')}</a>
    </div>
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
    <section className="sec" aria-labelledby="sec-sessions">
      <h2 id="sec-sessions">{t('settings', 'security.sessions')}</h2>
      <ul className="sessions">
        {sessions.map((session) => {
          const device =
            session.browser && session.os
              ? t('settings', 'security.device', { browser: session.browser, os: session.os })
              : (session.browser ?? session.os ?? t('settings', 'security.unknownDevice'));
          const times = { active: when.format(new Date(session.lastActiveAt)), created: day.format(new Date(session.createdAt)) };
          return (
            <li key={session.id} data-testid="session">
              <div>
                <b>{device}</b>
                {session.current && <span className="you">{t('settings', 'security.thisDevice')}</span>}
                <div className="hint">
                  {session.ip ? t('settings', 'security.meta', { ip: session.ip, ...times }) : t('settings', 'security.metaNoIp', times)}
                </div>
              </div>
              {session.current ? (
                <span className="hint">{t('settings', 'security.currentSession')}</span>
              ) : (
                <form method="post" action="/settings/security">
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="session" value={session.id} />
                  <Button type="submit" variant="neutral" size="sm">
                    {t('settings', 'security.revoke')}
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {sessions.length > 1 && (
        <form method="post" action="/settings/security" className="btns">
          <input type="hidden" name="intent" value="revoke-others" />
          <Button type="submit" variant="neutral">
            {t('settings', 'security.revokeOthers')}
          </Button>
        </form>
      )}
    </section>
  );
}
