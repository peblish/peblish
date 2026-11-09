import { auth } from '@peblish/core/identity/auth';
import { attempt } from '@peblish/core/identity/throttle';
import { maskEmail, verifyEmailToken } from '@peblish/core/identity/verify';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, rich } from './-ui/form.tsx';
import { AuthPage, authHead, SearchText } from './-ui/page.tsx';

const Search = type({ 'error?': SearchText, 'token?': SearchText, 'sent?': SearchText });

/**
 * With ?token (the emailed link) it applies the link; a POST server function, since that
 * writes. Without, it shows the signed-in person's pending or verified address.
 */
const loadVerify = createServerFn({ method: 'POST' })
  .validator(type({ 'token?': 'string' }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    if (data.token) return { state: await verifyEmailToken(data.token), email: null, signedIn: session !== null };
    if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/auth/verify' } });
    return {
      state: session.view.emailVerified ? ('verified' as const) : ('pending' as const),
      email: maskEmail(session.email),
      signedIn: true,
    };
  });

export const Route = createFileRoute('/auth/verify')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: ({ deps }) => loadVerify({ data: deps.token ? { token: deps.token } : {} }),
  head: authHead,
  component: Verify,
  server: {
    handlers: {
      // Send the link again: signed in, not yet verified, at most once a minute.
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: '/auth/sign-in?redirect=%2Fauth%2Fverify' });
        if (session.view.emailVerified) return reply({ redirect: '/auth/verify' });
        if (!(await attempt('verify-mail', { id: session.view.userId })).allowed)
          return reply({ error: 'resend.too_soon', back: '/auth/verify' });
        try {
          await (await auth()).api.sendVerificationEmail({ body: { email: session.email } });
        } catch (error) {
          console.error('verify: sending the link failed', error);
          return reply({ error: 'mail.failed', back: '/auth/verify' });
        }
        return reply({ redirect: '/auth/verify?sent=yes' });
      },
    },
  },
});

function Verify() {
  const { t } = useTranslate();
  const { state, email, signedIn } = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  const resend = (
    <AuthForm action="/auth/verify" label={t('auth', 'verify.resend')} error={asFormError(search.error)}>
      <div className="btns">
        <Button type="submit" variant="neutral">
          {t('auth', 'verify.resend')}
        </Button>
      </div>
    </AuthForm>
  );
  const signInForLink = (
    <p>
      {t('auth', 'verify.signInForLink')} <Link to="/auth/sign-in">{t('auth', 'verify.signIn')}</Link>
    </p>
  );
  return (
    <AuthPage>
      <div data-state={state}>
        {state === 'pending' && (
          <>
            <h1>{t('auth', 'verify.title')}</h1>
            <p>{rich(t('auth', 'verify.sent'), { email: <b>{email}</b> })}</p>
            <p className="auth-note">
              <b>{t('auth', 'verify.pending')}</b> <span className="muted">{t('auth', 'verify.pendingBody')}</span>
            </p>
            {search.sent && <p className="ok-t">{t('auth', 'verify.resent')}</p>}
            {resend}
          </>
        )}
        {state === 'verified' && (
          <>
            <h1 className="ok-t">{t('auth', 'verify.verifiedTitle')}</h1>
            <p>{t('auth', 'verify.verifiedBody')}</p>
            <a href="/">{t('auth', 'verify.continue')}</a>
          </>
        )}
        {state === 'used' && (
          <>
            <h1>{t('auth', 'verify.usedTitle')}</h1>
            <p>{t('auth', 'verify.usedBody')}</p>
            <Link to="/auth/sign-in">{t('auth', 'verify.signIn')}</Link>
          </>
        )}
        {(state === 'expired' || state === 'invalid') && (
          <>
            <h1 className="warn-t">{t('auth', state === 'expired' ? 'verify.expiredTitle' : 'verify.invalidTitle')}</h1>
            <p>{t('auth', state === 'expired' ? 'verify.expiredBody' : 'verify.invalidBody')}</p>
            {signedIn ? resend : signInForLink}
          </>
        )}
      </div>
    </AuthPage>
  );
}
