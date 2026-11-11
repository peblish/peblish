import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { attempt } from '@peblish/core/identity/throttle';
import { PASSWORD_MAX, PASSWORD_MIN } from '@peblish/schema/identity';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Separator } from '@peblish/ui/components/separator';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { clientIp, forbidden, readForm, respond, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field, Hidden } from './-ui/form.tsx';
import { authHead, SearchText } from './-route.ts';
import { AuthCard } from './-ui/page.tsx';

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
          // goes out in the background, and a failure to send is only logged. The budget is per
          // address typed, account or not, so being refused says nothing about an account either.
          const email = body.email.trim().toLowerCase();
          if (!(await attempt('reset-mail', { ip: clientIp(request), id: email })).allowed)
            return respond(request, { error: 'rate.limited', back: '/auth/reset' });
          await api.requestPasswordReset({ body: { email } });
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
      <AuthCard>
        <AuthForm action="/auth/reset" label={t('auth', 'reset.newTitle')} error={asFormError(search.error)} className="auth-form">
          <Text as="h1" variant="heading" size="sm">
            {t('auth', 'reset.newTitle')}
          </Text>
          <Hidden name="intent" value="reset" />
          <Hidden name="token" value={search.token} />
          <Field
            label={t('auth', 'reset.newPassword')}
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            hint={t('auth', 'reset.newHint')}
          />
          <Button type="submit" variant="primary" className="auth-submit">
            {t('auth', 'reset.save')}
          </Button>
        </AuthForm>
      </AuthCard>
    );
  return (
    <AuthCard>
      <AuthForm action="/auth/reset" label={t('auth', 'reset.title')} error={asFormError(search.error)} className="auth-form">
        <Text as="h1" variant="heading" size="sm">
          {t('auth', 'reset.title')}
        </Text>
        {search.sent ? <Notice tone="success">{t('auth', 'reset.sent')}</Notice> : <Text as="p">{t('auth', 'reset.intro')}</Text>}
        <Hidden name="intent" value="request" />
        <Field label={t('auth', 'reset.email')} name="email" type="email" required autoComplete="email" />
        <Button type="submit" variant="primary" className="auth-submit">
          {t('auth', 'reset.submit')}
        </Button>
        <Separator />
        <Text as="p" size="sm">
          <Link href="/auth/sign-in">{t('auth', 'reset.back')}</Link>
        </Text>
      </AuthForm>
    </AuthCard>
  );
}
