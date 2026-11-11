import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { localHandles, loginEmail } from '@peblish/core/identity/handles';
import { attempt } from '@peblish/core/identity/throttle';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Separator } from '@peblish/ui/components/separator';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { clientIp, forbidden, forwardedHeaders, readForm, respond, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field, Hidden } from './-ui/form.tsx';
import { authHead, SearchText } from './-route.ts';
import { AuthCard } from './-ui/page.tsx';

const Search = type({ 'error?': SearchText, 'redirect?': SearchText, 'reset?': SearchText });
const Body = type({ identifier: 'string', password: 'string', 'redirect?': 'string' });

export const Route = createFileRoute('/auth/sign-in')({
  validateSearch: Search,
  head: authHead,
  component: SignIn,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', back: '/auth/sign-in' });
        const failed = { error: 'credentials.invalid', back: '/auth/sign-in', keep: { redirect: body.redirect } } as const;
        const email = await loginEmail(body.identifier);
        // Counted by address and by account (or what was typed, when no account matches); a
        // success is refunded, so only wrong passwords use the budget.
        const counted = await attempt('sign-in', { ip: clientIp(request), id: email ?? body.identifier });
        if (!counted.allowed) return respond(request, { ...failed, error: 'rate.limited' });
        if (!email) return respond(request, failed);
        try {
          const { headers, response } = await (
            await auth()
          ).api.signInEmail({
            body: { email, password: body.password, rememberMe: true },
            headers: forwardedHeaders(request),
            returnHeaders: true,
          });
          await counted.refund();
          const cookies = headers.getSetCookie();
          const next = safeRedirect(body.redirect, (await localHandles()).origin);
          // Two-factor accounts get a short-lived two-factor cookie instead of a session.
          if ('twoFactorRedirect' in response && response.twoFactorRedirect)
            return respond(request, { redirect: `/auth/two-factor?redirect=${encodeURIComponent(next)}`, cookies });
          return respond(request, { redirect: next, cookies });
        } catch (error) {
          if (authErrorCode(error) === undefined) throw error;
          return respond(request, failed);
        }
      },
    },
  },
});

function SignIn() {
  const { t } = useTranslate();
  const search = Route.useSearch();
  useRouteHydrated();
  return (
    <AuthCard>
      <AuthForm action="/auth/sign-in" label={t('auth', 'signIn.title')} error={asFormError(search.error)} className="auth-form">
        <Text as="h1" variant="heading" size="sm">
          {t('auth', 'signIn.title')}
        </Text>
        {search.reset && <Notice tone="success">{t('auth', 'signIn.resetDone')}</Notice>}
        {search.redirect && <Hidden name="redirect" value={search.redirect} />}
        <Field
          label={t('auth', 'signIn.identifier')}
          name="identifier"
          type="text"
          required
          autoComplete="username"
          placeholder={t('auth', 'signIn.identifierPlaceholder')}
        />
        <Field
          label={t('auth', 'signIn.password')}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          aside={
            <Text size="sm">
              <Link href="/auth/reset">{t('auth', 'signIn.forgot')}</Link>
            </Text>
          }
        />
        <Button type="submit" variant="primary" className="auth-submit">
          {t('auth', 'signIn.submit')}
        </Button>
        <Separator />
        <Text as="p" size="sm" color="muted">
          {t('auth', 'signIn.noAccount')} <Link href="/auth/sign-up">{t('auth', 'signIn.signUp')}</Link>
        </Text>
      </AuthForm>
    </AuthCard>
  );
}
