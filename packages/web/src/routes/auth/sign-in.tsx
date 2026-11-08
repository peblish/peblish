import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { localHandles, loginEmail } from '@peblish/core/identity/handles';
import { attempt } from '@peblish/core/identity/throttle';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { clientIp, forbidden, forwardedHeaders, readForm, respond, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field } from './-ui/form.tsx';
import { AuthPage, authHead, SearchText } from './-ui/page.tsx';

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
    <AuthPage>
      <AuthForm action="/auth/sign-in" label={t('auth', 'signIn.title')} error={asFormError(search.error)}>
        <h1>{t('auth', 'signIn.title')}</h1>
        {search.reset && <p className="auth-note ok-t">{t('auth', 'signIn.resetDone')}</p>}
        {search.redirect && <input type="hidden" name="redirect" value={search.redirect} />}
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
            <Link to="/auth/reset" className="hint">
              {t('auth', 'signIn.forgot')}
            </Link>
          }
        />
        <div className="btns">
          <Button type="submit" variant="primary">
            {t('auth', 'signIn.submit')}
          </Button>
          <span className="hint">
            {t('auth', 'signIn.noAccount')} <Link to="/auth/sign-up">{t('auth', 'signIn.signUp')}</Link>
          </span>
        </div>
      </AuthForm>
    </AuthPage>
  );
}
