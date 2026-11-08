import { auth } from '@peblish/core/identity/auth';
import { localHandles } from '@peblish/core/identity/handles';
import { lookupInvite } from '@peblish/core/registration/invites';
import { register } from '@peblish/core/registration/register';
import { ageOn, dateOfBirth, SignUpBody } from '@peblish/schema/identity';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useId } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { ageGateCookie, ageGated, forbidden, forwardedHeaders, readForm, respond, sameOrigin } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field, rich } from './-ui/form.tsx';
import { AuthPage, authHead, SearchText } from './-ui/page.tsx';

const Search = type({ 'error?': SearchText, 'invite?': SearchText, 'username?': SearchText });

const loadSignUp = createServerFn({ method: 'GET' })
  .validator(type({ 'invite?': 'string' }))
  .handler(async ({ data }) => {
    const { host } = await localHandles();
    // An under-16 answer blocks this browser for 24 hours (server/auth.ts).
    if (ageGated(getRequest())) return { host, blocked: true, invite: null };
    return { host, blocked: false, invite: data.invite ? await lookupInvite(data.invite) : null };
  });

export const Route = createFileRoute('/auth/sign-up')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ invite: search.invite }),
  loader: ({ deps }) => loadSignUp({ data: deps.invite ? { invite: deps.invite } : {} }),
  head: authHead,
  component: SignUp,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        if (ageGated(request)) return respond(request, { redirect: '/auth/sign-up' });
        const body = SignUpBody(await readForm(request));
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', back: '/auth/sign-up' });
        const back = { back: '/auth/sign-up', keep: { invite: body.invite, username: body.username } };
        if (body.terms !== 'on') return respond(request, { error: 'terms.required', ...back });
        const dob = dateOfBirth(body.day, body.month, body.year);
        const result = await register({
          inviteCode: body.invite,
          name: body.username.trim(),
          email: body.email,
          password: body.password,
          age: dob ? ageOn(dob) : null,
        });
        if (!result.ok) {
          if (result.reason === 'age.under_16') return respond(request, { redirect: '/auth/sign-up', cookies: [await ageGateCookie()] });
          return respond(request, { error: asFormError(result.reason) ?? 'generic', ...back });
        }
        const api = (await auth()).api;
        const { headers } = await api.signInEmail({
          body: { email: result.email, password: body.password, rememberMe: true },
          headers: forwardedHeaders(request),
          returnHeaders: true,
        });
        try {
          await api.sendVerificationEmail({ body: { email: result.email } });
        } catch (error) {
          // The account exists; the verify page offers to send the link again.
          console.error('sign-up: the verification email failed', error);
        }
        return respond(request, { redirect: '/auth/verify', cookies: headers.getSetCookie() });
      },
    },
  },
});

function SignUp() {
  const data = Route.useLoaderData();
  useRouteHydrated();
  return <AuthPage>{data.blocked ? <UnderSixteen host={data.host} /> : <SignUpForm />}</AuthPage>;
}

function UnderSixteen({ host }: { host: string }) {
  const { t } = useTranslate();
  return (
    <div role="alert">
      <h1>{t('auth', 'under16.title')}</h1>
      <p>{t('auth', 'under16.body', { host })}</p>
      <p className="hint">{t('auth', 'under16.retry')}</p>
      <a href="/">{t('auth', 'under16.back', { host })}</a>
    </div>
  );
}

function SignUpForm() {
  const { locale, t } = useTranslate();
  const search = Route.useSearch();
  const { host, invite } = Route.useLoaderData();
  const dobLabel = useId();
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return (
    <AuthForm action="/auth/sign-up" label={t('auth', 'signUp.title')} error={asFormError(search.error)}>
      <h1>{t('auth', 'signUp.title')}</h1>
      <Field
        label={t('auth', 'signUp.invite')}
        name="invite"
        required
        defaultValue={search.invite}
        autoComplete="off"
        hint={
          invite?.status === 'valid' && invite.inviter ? (
            <span className="ok-t">
              {t('auth', 'signUp.inviteValid', { inviter: invite.inviter.handle, left: invite.usesLeft, max: invite.maxUses })}
            </span>
          ) : invite && invite.status !== 'valid' ? (
            <span className="err-t">{t('auth', `error.invite.${invite.status}`)}</span>
          ) : undefined
        }
      />
      <Field
        label={t('auth', 'signUp.username')}
        name="username"
        required
        defaultValue={search.username}
        autoComplete="username"
        placeholder={t('auth', 'signUp.usernamePlaceholder')}
        hint={t('auth', 'signUp.usernameHint', { host })}
      />
      <Field label={t('auth', 'signUp.email')} name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
      <Field
        label={t('auth', 'signUp.password')}
        name="password"
        type="password"
        required
        minLength={12}
        autoComplete="new-password"
        hint={t('auth', 'signUp.passwordHint')}
      />
      <div className="fld">
        <span className="lb" id={dobLabel}>
          {t('auth', 'signUp.dob')}
        </span>
        <div className="dob" role="group" aria-labelledby={dobLabel}>
          <label>
            <span className="sr">{t('auth', 'signUp.day')}</span>
            <input name="day" inputMode="numeric" maxLength={2} required placeholder={t('auth', 'signUp.dayPlaceholder')} />
          </label>
          <label>
            <span className="sr">{t('auth', 'signUp.month')}</span>
            <select name="month" required defaultValue="">
              <option value="" disabled>
                {t('auth', 'signUp.month')}
              </option>
              {Array.from({ length: 12 }, (_, month) => (
                <option key={month} value={month + 1}>
                  {monthName.format(Date.UTC(2000, month, 1))}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr">{t('auth', 'signUp.year')}</span>
            <input name="year" inputMode="numeric" maxLength={4} required placeholder={t('auth', 'signUp.yearPlaceholder')} />
          </label>
        </div>
        <span className="hint">{t('auth', 'signUp.dobHint')}</span>
      </div>
      <label className="chk">
        <input type="checkbox" name="terms" required />
        <span>
          {rich(t('auth', 'signUp.terms'), {
            terms: <a href="/terms">{t('auth', 'signUp.termsLink')}</a>,
            privacy: <a href="/privacy">{t('auth', 'signUp.privacyLink')}</a>,
            rules: <a href="/rules">{t('auth', 'signUp.rulesLink')}</a>,
          })}
        </span>
      </label>
      <div className="btns">
        <Button type="submit" variant="primary">
          {t('auth', 'signUp.submit')}
        </Button>
        <span className="hint">
          {t('auth', 'signUp.haveAccount')} <Link to="/auth/sign-in">{t('auth', 'signUp.signIn')}</Link>
        </span>
      </div>
    </AuthForm>
  );
}
