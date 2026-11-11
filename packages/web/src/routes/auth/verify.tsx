import { auth } from '@peblish/core/identity/auth';
import { attempt } from '@peblish/core/identity/throttle';
import { maskEmail, verifyEmailToken } from '@peblish/core/identity/verify';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import type { MessageKey } from '../../i18n/translate.ts';
import { useTranslate } from '../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, rich } from './-ui/form.tsx';
import { AuthCard, authHead, SearchText } from './-ui/page.tsx';

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
    <AuthForm action="/auth/verify" label={t('auth', 'verify.resend')} error={asFormError(search.error)} className="auth-form">
      <Button type="submit" variant="neutral" className="auth-submit">
        {t('auth', 'verify.resend')}
      </Button>
    </AuthForm>
  );
  const signInForLink = (
    <Text as="p">
      {t('auth', 'verify.signInForLink')} <Link href="/auth/sign-in">{t('auth', 'verify.signIn')}</Link>
    </Text>
  );
  const title = (key: MessageKey<'auth'>) => (
    <Text as="h1" variant="heading" size="sm">
      {t('auth', key)}
    </Text>
  );
  return (
    <AuthCard state={state}>
      <div className="auth-form">
        {state === 'pending' && (
          <>
            {title('verify.title')}
            <Text as="p">
              {rich(t('auth', 'verify.sent'), {
                email: (
                  <Text variant="label" size="md">
                    {email}
                  </Text>
                ),
              })}
            </Text>
            <Notice tone="warning" title={t('auth', 'verify.pending')}>
              {t('auth', 'verify.pendingBody')}
            </Notice>
            {search.sent && (
              <Notice tone="success" role="status">
                {t('auth', 'verify.resent')}
              </Notice>
            )}
            {resend}
          </>
        )}
        {state === 'verified' && (
          <>
            {title('verify.verifiedTitle')}
            <Notice tone="success">{t('auth', 'verify.verifiedBody')}</Notice>
            <Text as="p">
              <Link href="/">{t('auth', 'verify.continue')}</Link>
            </Text>
          </>
        )}
        {state === 'used' && (
          <>
            {title('verify.usedTitle')}
            <Text as="p">{t('auth', 'verify.usedBody')}</Text>
            <Text as="p">
              <Link href="/auth/sign-in">{t('auth', 'verify.signIn')}</Link>
            </Text>
          </>
        )}
        {(state === 'expired' || state === 'invalid') && (
          <>
            {title(state === 'expired' ? 'verify.expiredTitle' : 'verify.invalidTitle')}
            <Notice tone="warning">{t('auth', state === 'expired' ? 'verify.expiredBody' : 'verify.invalidBody')}</Notice>
            {signedIn ? resend : signInForLink}
          </>
        )}
      </div>
    </AuthCard>
  );
}
