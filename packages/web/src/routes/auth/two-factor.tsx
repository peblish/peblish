import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { localHandles } from '@peblish/core/identity/handles';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Separator } from '@peblish/ui/components/separator';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { forbidden, forwardedHeaders, readForm, respond, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field, Hidden } from './-ui/form.tsx';
import { authHead, SearchText } from './-route.ts';
import { AuthCard } from './-ui/page.tsx';

const Search = type({ 'error?': SearchText, 'redirect?': SearchText, 'recovery?': SearchText });
const Body = type({ code: 'string', method: "'totp' | 'recovery'", 'redirect?': 'string' });

/** better-auth's codes for a gone two-factor cookie (expired, or five wrong codes): sign in again. */
const expiredCodes = new Set(['INVALID_TWO_FACTOR_COOKIE', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE']);

export const Route = createFileRoute('/auth/two-factor')({
  validateSearch: Search,
  head: authHead,
  component: TwoFactor,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', back: '/auth/two-factor' });
        const keep = { redirect: body.redirect, recovery: body.method === 'recovery' ? 'yes' : undefined };
        const api = (await auth()).api;
        const options = { headers: forwardedHeaders(request), returnHeaders: true } as const;
        try {
          const code = body.code.trim();
          const { headers } =
            body.method === 'totp'
              ? await api.verifyTOTP({ body: { code: code.replace(/\s/g, ''), trustDevice: false }, ...options })
              : await api.verifyBackupCode({ body: { code, trustDevice: false }, ...options });
          return respond(request, {
            redirect: safeRedirect(body.redirect, (await localHandles()).origin),
            cookies: headers.getSetCookie(),
          });
        } catch (error) {
          const code = authErrorCode(error);
          if (code === undefined) throw error;
          if (expiredCodes.has(code))
            return respond(request, { error: 'two_factor.expired', back: '/auth/sign-in', keep: { redirect: body.redirect } });
          // Repeated failures lock the account's second factor for a while (auth_two_factor.locked_until).
          if (code === 'ACCOUNT_TEMPORARILY_LOCKED')
            return respond(request, { error: 'two_factor.locked', back: '/auth/two-factor', keep });
          return respond(request, { error: 'two_factor.invalid_code', back: '/auth/two-factor', keep });
        }
      },
    },
  },
});

function TwoFactor() {
  const { t } = useTranslate();
  const search = Route.useSearch();
  const recovery = search.recovery !== undefined;
  useRouteHydrated();
  const other = new URLSearchParams();
  if (search.redirect) other.set('redirect', search.redirect);
  if (!recovery) other.set('recovery', 'yes');
  const query = other.toString();
  const otherHref = query ? `/auth/two-factor?${query}` : '/auth/two-factor';
  return (
    <AuthCard>
      <AuthForm
        action="/auth/two-factor"
        label={t('auth', recovery ? 'twoFactor.recoveryTitle' : 'twoFactor.title')}
        error={asFormError(search.error)}
        className="auth-form"
      >
        <Text as="h1" variant="heading" size="sm">
          {t('auth', recovery ? 'twoFactor.recoveryTitle' : 'twoFactor.title')}
        </Text>
        <Text as="p">{t('auth', recovery ? 'twoFactor.recoveryIntro' : 'twoFactor.intro')}</Text>
        <Hidden name="method" value={recovery ? 'recovery' : 'totp'} />
        {search.redirect && <Hidden name="redirect" value={search.redirect} />}
        {recovery ? (
          <Field
            label={t('auth', 'twoFactor.recoveryCode')}
            name="code"
            required
            autoComplete="off"
            className="auth-code auth-code--mono"
          />
        ) : (
          <Field
            label={t('auth', 'twoFactor.code')}
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            className="auth-code"
          />
        )}
        <Button type="submit" variant="primary" className="auth-submit">
          {t('auth', 'twoFactor.submit')}
        </Button>
        <Separator />
        <Text as="p" size="sm">
          <Link href={otherHref}>{t('auth', recovery ? 'twoFactor.useApp' : 'twoFactor.useRecovery')}</Link>
        </Text>
      </AuthForm>
    </AuthCard>
  );
}
