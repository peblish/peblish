import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { PASSWORD_MAX, PASSWORD_MIN } from '@peblish/schema/identity';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { forbidden, readForm, respond, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field } from './-ui/form.tsx';
import { AuthPage, authHead, SearchText } from './-ui/page.tsx';

const Search = type({ 'error?': SearchText, 'token?': SearchText, 'sent?': SearchText });
const Body = type({ intent: "'request'", email: 'string' }).or({ intent: "'reset'", token: 'string', password: 'string' });

export const Route = createFileRoute('/auth/reset')({
  validateSearch: Search,
  head: authHead,
  component: Reset,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', back: '/auth/reset' });
        const api = (await auth()).api;
        if (body.intent === 'request') {
          // Answers the same, as fast, whether or not an account uses the address: the mail
          // goes out in the background, and a failure to send is only logged.
          await api.requestPasswordReset({ body: { email: body.email.trim().toLowerCase() } });
          return respond(request, { redirect: '/auth/reset?sent=yes' });
        }
        const back = { back: '/auth/reset', keep: { token: body.token } };
        if (body.password.length < PASSWORD_MIN) return respond(request, { error: 'password.too_short', ...back });
        if (body.password.length > PASSWORD_MAX) return respond(request, { error: 'password.too_long', ...back });
        try {
          // Every session ends (revokeSessionsOnPasswordReset).
          await api.resetPassword({ body: { token: body.token, newPassword: body.password } });
        } catch (error) {
          if (authErrorCode(error) === undefined) throw error;
          return respond(request, { error: 'reset.invalid', ...back });
        }
        return respond(request, { redirect: '/auth/sign-in?reset=done' });
      },
    },
  },
});

function Reset() {
  const { t } = useTranslate();
  const search = Route.useSearch();
  useRouteHydrated();
  if (search.token)
    return (
      <AuthPage>
        <AuthForm action="/auth/reset" label={t('auth', 'reset.newTitle')} error={asFormError(search.error)}>
          <h1>{t('auth', 'reset.newTitle')}</h1>
          <input type="hidden" name="intent" value="reset" />
          <input type="hidden" name="token" value={search.token} />
          <Field
            label={t('auth', 'reset.newPassword')}
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            hint={t('auth', 'reset.newHint')}
          />
          <Button type="submit" variant="primary">
            {t('auth', 'reset.save')}
          </Button>
        </AuthForm>
      </AuthPage>
    );
  return (
    <AuthPage>
      <AuthForm action="/auth/reset" label={t('auth', 'reset.title')} error={asFormError(search.error)}>
        <h1>{t('auth', 'reset.title')}</h1>
        {search.sent ? <p className="auth-note ok-t">{t('auth', 'reset.sent')}</p> : <p>{t('auth', 'reset.intro')}</p>}
        <input type="hidden" name="intent" value="request" />
        <Field label={t('auth', 'reset.email')} name="email" type="email" required autoComplete="email" />
        <div className="btns">
          <Button type="submit" variant="primary">
            {t('auth', 'reset.submit')}
          </Button>
          <Link to="/auth/sign-in" className="hint">
            {t('auth', 'reset.back')}
          </Link>
        </div>
      </AuthForm>
    </AuthPage>
  );
}
